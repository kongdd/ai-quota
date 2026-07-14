import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRemain, QuotaResponse } from "./minimax.js";

/** Grok Build CLI 代理的 billing 端点（cli-chat-proxy.grok.com）—— 与官方 `grok /usage` 同源。 */
const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
/** pi-agent / pi-grok-cli 在 auth.json 里用的 provider key（也兼容 pi-xai 的 grok-build）。 */
const PI_AUTH_KEYS = ["grok-cli", "grok-build"] as const;

export class GrokAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "GrokAuthError";
  }
}

/**
 * 解析后的 Grok Build 订阅 OAuth token。
 * 优先从 pi agent 的 `~/.pi/agent/auth.json` 读 `grok-cli` / `grok-build` OAuth 条目；
 * 若缺，回退到官方 Grok CLI 的 `~/.grok/auth.json`。
 * 本 provider 只读不写，也不刷新 token。
 */
export interface GrokSubscriptionConfig {
  /** Grok Build OAuth access token */
  accessToken: string;
  /** API base（含 /v1）；缺省 DEFAULT_BASE_URL */
  baseUrl?: string;
}

/** pi agent 默认 auth.json：`$PI_CONFIG_DIR/auth.json` 或 `~/.pi/agent/auth.json`。 */
export function defaultAuthPath(): string {
  if (process.env.PI_CONFIG_DIR) return join(process.env.PI_CONFIG_DIR, "auth.json");
  return join(homedir(), ".pi", "agent", "auth.json");
}

function officialGrokAuthPath(): string {
  return join(homedir(), ".grok", "auth.json");
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function pickAccess(entry: Record<string, unknown>): string | undefined {
  const access = entry.access ?? entry.key ?? entry.access_token ?? entry.token;
  return typeof access === "string" && access.trim() ? access.trim() : undefined;
}

function pickBaseUrl(entry: Record<string, unknown>): string | undefined {
  const base = entry.baseUrl ?? entry.base_url;
  return typeof base === "string" && base.trim() ? base.trim().replace(/\/$/, "") : undefined;
}

/** 从 pi agent auth.json 读 grok-cli / grok-build OAuth 条目。 */
function loadFromPiAuth(parsed: unknown): GrokSubscriptionConfig | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  for (const key of PI_AUTH_KEYS) {
    const entry = root[key];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    // type 缺失时仍尝试读 access（兼容手动编辑的简化条目）
    if (e.type !== undefined && e.type !== "oauth" && e.type !== "api_key") continue;
    const accessToken = pickAccess(e);
    if (!accessToken) continue;
    const baseUrl = pickBaseUrl(e);
    return baseUrl ? { accessToken, baseUrl } : { accessToken };
  }
  return undefined;
}

/** 从官方 Grok CLI `~/.grok/auth.json` 读 token（canonical / legacy 两种 key 形态）。 */
function loadFromOfficialGrokAuth(parsed: unknown): GrokSubscriptionConfig | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;

  // 1. canonical: keys 前缀为 "https://auth.x.ai::<client-id>"
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("https://auth.x.ai::")) continue;
    if (!value || typeof value !== "object") continue;
    const accessToken = pickAccess(value as Record<string, unknown>);
    if (accessToken) return { accessToken };
  }

  // 2. legacy: 顶层 "https://accounts.x.ai/sign-in"
  const legacy = root["https://accounts.x.ai/sign-in"];
  if (legacy && typeof legacy === "object") {
    const accessToken = pickAccess(legacy as Record<string, unknown>);
    if (accessToken) return { accessToken };
  }
  return undefined;
}

/**
 * 加载 Grok Build OAuth access token。
 * @param authPath 主 auth.json 路径（默认 `~/.pi/agent/auth.json`）；也可传官方 `~/.grok/auth.json`。
 */
export function loadGrokSubscriptionConfig(authPath = defaultAuthPath()): GrokSubscriptionConfig | undefined {
  // 1. 主路径：先按 pi agent 形态解析，再按官方 Grok CLI 形态解析（同一路径可能是两种文件之一）
  const primary = readJson(authPath);
  const fromPi = loadFromPiAuth(primary);
  if (fromPi) return fromPi;
  const fromOfficialPrimary = loadFromOfficialGrokAuth(primary);
  if (fromOfficialPrimary) return fromOfficialPrimary;

  // 2. 回退：主路径不是官方路径时，再试 `~/.grok/auth.json`
  const official = officialGrokAuthPath();
  if (authPath !== official) {
    const fromOfficial = loadFromOfficialGrokAuth(readJson(official));
    if (fromOfficial) return fromOfficial;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Billing 响应解析
 * 月度: { config: { monthlyLimit, used, billingPeriodEnd } } —— 数值字段
 *       可能是裸 number 也可能是 { val: number } 包装（cost-tracking 同款）。
 * 周度: ?format=credits 时 config.currentPeriod.type === "USAGE_PERIOD_TYPE_WEEKLY"，
 *       并附 creditUsagePercent; 周期结束优先取 currentPeriod.end，回落到月度字段。
 * ------------------------------------------------------------------ */

interface RawBilling {
  config?: {
    monthlyLimit?: number | { val: number };
    used?: number | { val: number };
    billingPeriodEnd?: string;
    currentPeriod?: { type?: string; end?: string };
    creditUsagePercent?: number;
  };
}

interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

function unwrap(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
    return (v as { val: number }).val;
  }
  return undefined;
}

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function billingHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
  };
}

function billingUrl(baseUrl: string | undefined, path: string): string {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  // base 已含 /v1；path 为 "" 或 "?format=credits"
  return `${base}/billing${path}`;
}

async function fetchBilling(
  path: string,
  token: string,
  timeoutMs: number,
  baseUrl?: string,
): Promise<RawBilling> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(billingUrl(baseUrl, path), {
      method: "GET",
      headers: billingHeaders(token),
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new GrokAuthError(
        "Grok Build billing requires a SuperGrok / X Premium OAuth token — re-login via pi (`/login` grok-cli) or refresh ~/.pi/agent/auth.json",
        false,
      );
    }
    if (!resp.ok) {
      throw new GrokAuthError(`billing endpoint returned ${resp.status}`, resp.status >= 500);
    }
    return (await resp.json()) as RawBilling;
  } catch (e) {
    if (e instanceof GrokAuthError) throw e;
    throw new GrokAuthError(`billing: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** 把月度 + 周度数据归一到单行 ModelRemain：
 *  - interval (首列) = 周使用池 (7 天滚动百分比)
 *  - weekly  (次列) = 月度信用额度 (已用 / 限额)
 *  不设 balance —— format.ts 见到 balance 就只渲染首列；这里两个并列指标都重要，让两列都渲染。 */
function toModelRemain(monthly: MonthlyUsage, weekly: WeeklyUsage | undefined): ModelRemain {
  const nowMs = Date.now();
  const monthlyEndMs = parseMs(monthly.billingPeriodEnd) ?? nowMs;
  const monthlyUsedPercent = (monthly.used / monthly.monthlyLimit) * 100;
  const weeklyEndMs = parseMs(weekly?.billingPeriodEnd) ?? monthlyEndMs;
  const weeklyUsedPercent = weekly?.creditUsagePercent ?? monthlyUsedPercent;
  return {
    model_name: "grok",
    interval: {
      remaining_percent: Math.max(0, 100 - weeklyUsedPercent),
      remains_time: Math.max(0, weeklyEndMs - nowMs),
      end_time: weeklyEndMs,
      status: weeklyUsedPercent >= 100 ? 3 : 1,
    },
    weekly: {
      remaining_percent: Math.max(0, 100 - monthlyUsedPercent),
      remains_time: Math.max(0, monthlyEndMs - nowMs),
      end_time: monthlyEndMs,
      status: monthlyUsedPercent >= 100 ? 3 : 1,
    },
  };
}

/** 拉取 Grok Build 订阅额度：月度信用额度 + 周使用池。需 `~/.pi/agent/auth.json` 的 `grok-cli` OAuth 条目。 */
export async function queryQuota(
  opts: { authPath?: string; timeoutMs?: number } = {},
): Promise<QuotaResponse> {
  const cfg = loadGrokSubscriptionConfig(opts.authPath);
  if (!cfg) {
    throw new GrokAuthError(
      "Grok Build credentials not found — need `grok-cli` OAuth in ~/.pi/agent/auth.json (pi `/login`), or `ai-quota auth disable grok` to skip",
      false,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const monthlyResp = await fetchBilling("", cfg.accessToken, timeoutMs, cfg.baseUrl);
  const config = monthlyResp.config;
  if (!config) throw new GrokAuthError("invalid billing payload: missing config", false);
  const monthlyLimit = unwrap(config.monthlyLimit);
  const used = unwrap(config.used);
  const billingPeriodEnd =
    typeof config.billingPeriodEnd === "string" && parseMs(config.billingPeriodEnd) ? config.billingPeriodEnd : undefined;
  if (monthlyLimit === undefined || used === undefined || billingPeriodEnd === undefined) {
    throw new GrokAuthError("invalid billing payload: monthlyLimit/used/billingPeriodEnd missing", false);
  }

  // 周使用池：best-effort，缺字段时不阻塞月度数据
  let weekly: WeeklyUsage | undefined;
  try {
    const weeklyResp = await fetchBilling("?format=credits", cfg.accessToken, timeoutMs, cfg.baseUrl);
    const c = weeklyResp.config;
    if (c?.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" && typeof c.creditUsagePercent === "number") {
      const end = typeof c.currentPeriod.end === "string" ? c.currentPeriod.end : billingPeriodEnd;
      weekly = { creditUsagePercent: c.creditUsagePercent, billingPeriodEnd: end };
    }
  } catch {
    weekly = undefined;
  }

  return {
    base_resp: { status_code: 0, status_msg: "ok" },
    model_remains: [toModelRemain({ monthlyLimit, used, billingPeriodEnd }, weekly)],
  };
}