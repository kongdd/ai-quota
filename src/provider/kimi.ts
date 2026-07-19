import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRemain, QuotaResponse } from "./minimax.js";

/**
 * Kimi Coding Plan（Moonshot AI 会员订阅）配额查询。
 *
 * Coding Plan 与 Moonshot Open Platform 是两套独立计费系统，key 不互通：
 *   - 会员 key (`sk-kimi-…`) → `api.kimi.com/coding/v1/usages`
 *   - Open Platform PAYG key → `api.moonshot.ai/v1/users/me/balance`（不同 endpoint，本 provider 不处理）
 *
 * 响应（数字字段是字符串）：
 * ```jsonc
 * {
 *   "usage":  { "limit": "100", "used": "33", "remaining": "67", "resetTime": "..." },
 *   "limits": [{ "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                "detail": { "limit": "100", "used": "2", "remaining": "98", "resetTime": "..." } }],
 *   "user":   { "membership": { "level": "LEVEL_INTERMEDIATE" } }
 * }
 * ```
 *   - `usage`    = 7 天会员配额（整体）
 *   - `limits[0]` = 5h 滚动速率窗口（`duration=300` 分钟）
 *   - `resetTime` 是 ISO 8601；按订阅日滚动的窗口，不是自然周/月
 */

const CODING_PLAN_URL = "https://api.kimi.com/coding/v1/usages";
/** Moonshot 同形 `/usages`；Coding Plan key 不通用，仅作 fallback。 */
const MOONSHOT_USAGE_URL = "https://api.moonshot.ai/v1/usages";

interface RawUsage {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
}

interface RawResponse {
  usage?: RawUsage;
  limits?: Array<{ window?: { duration?: unknown }; detail?: RawUsage }>;
}

export class KimiAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "KimiAuthError";
  }
}

/** 把字符串或数字解析成有限 number；Kimi 把 limit/used/remaining 序列化成字符串。 */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 解析 ISO 8601 → epoch ms；失败返回 undefined。 */
function parseMs(iso: unknown): number | undefined {
  if (typeof iso !== "string" || !iso.trim()) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 从 `limit` / `used` / `remaining` 算 used 百分比 (0–100)；优先 used，回退 limit - remaining。 */
function usedPercent(d: RawUsage | undefined): number | undefined {
  if (!d) return undefined;
  const limit = num(d.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const used = num(d.used);
  if (used !== undefined) return Math.max(0, Math.min(100, (used / limit) * 100));
  const remaining = num(d.remaining);
  if (remaining !== undefined) return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  return undefined;
}

/** 把单窗口归一化到 IntervalQuota / WeeklyQuota；resetTime 缺失时用 fallbackMs 占位避免渲染 NaN。 */
function toQuota(usedPct: number | undefined, resetIso: unknown, nowMs: number, fallbackMs: number) {
  const used = usedPct ?? 0;
  const endMs = parseMs(resetIso) ?? fallbackMs;
  return {
    remaining_percent: Math.max(0, 100 - used),
    remains_time: Math.max(0, endMs - nowMs),
    end_time: endMs,
    status: used >= 100 ? 3 : 1,
  };
}

/** 把 Coding Plan 响应归一化到一个 ModelRemain：5h → interval；weekly → weekly（缺失时降级到 5h）。 */
function normalize(data: RawResponse, nowMs: number): ModelRemain {
  const fiveHour = data.limits?.[0]?.detail;
  const weekly = data.usage;
  const intervalPct = usedPercent(fiveHour);
  const weeklyPct = usedPercent(weekly) ?? intervalPct;
  const interval = toQuota(intervalPct, fiveHour?.resetTime, nowMs, nowMs + 5 * 3_600_000);
  const weeklyEnd = toQuota(weeklyPct, weekly?.resetTime, nowMs, interval.end_time);
  return { model_name: "kimi", interval, weekly: weeklyEnd };
}

async function fetchUsage(url: string, apiKey: string, timeoutMs: number): Promise<RawResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new KimiAuthError(
        `Kimi rejected the API key (HTTP ${resp.status}); create a key at kimi.com/code console — ` +
          `Open Platform keys (platform.moonshot.cn) do not work here`,
        false,
      );
    }
    if (!resp.ok) throw new KimiAuthError(`HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`, resp.status >= 500);
    return (await resp.json()) as RawResponse;
  } catch (e) {
    if (e instanceof KimiAuthError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new KimiAuthError(e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `network: ${msg}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** pi agent 默认 auth.json 路径：`$PI_CONFIG_DIR/auth.json` 或 `~/.pi/agent/auth.json`。 */
export function defaultAuthPath(): string {
  if (process.env.PI_CONFIG_DIR) return join(process.env.PI_CONFIG_DIR, "auth.json");
  return join(homedir(), ".pi", "agent", "auth.json");
}

/** 从 pi agent auth.json 的 `kimi-coding` 条目读取 api_key。 */
function loadKimiKeyFromAuth(authPath = defaultAuthPath()): string | undefined {
  if (!existsSync(authPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const entry = (parsed as Record<string, unknown>)["kimi-coding"];
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const key = e.key ?? e.access ?? e.access_token ?? e.token;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** 解析 Coding Plan API key：`KIMI_API_KEY` > `KIMI_CODING_API_KEY` > `MOONSHOT_API_KEY` > `~/.pi/agent/auth.json`。 */
export function resolveKimiApiKey(): string | undefined {
  return (
    process.env.KIMI_API_KEY ??
    process.env.KIMI_CODING_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    loadKimiKeyFromAuth()
  );
}

/**
 * 拉取 Kimi Coding Plan 5h + 7 天配额。
 * Coding Plan 端点 401/403 时回退 Moonshot Open Platform（同形响应，PAYG key 可用）。
 */
export async function queryQuota(apiKey: string, timeoutMs = 15_000): Promise<QuotaResponse> {
  const fetch = (url: string) => fetchUsage(url, apiKey, timeoutMs);
  const primary = await fetch(CODING_PLAN_URL).catch((e: unknown) => {
    if (e instanceof KimiAuthError && !e.retryable) return fetch(MOONSHOT_USAGE_URL);
    throw e;
  });
  return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: [normalize(primary, Date.now())] };
}