import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRemain, QuotaResponse } from "./minimax.js";

export class OpencodeAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "OpencodeAuthError";
  }
}

/**
 * OpenCode CLI 持久化的 `auth.json` 结构（镜像 sst/opencode `auth/index.ts`）。
 * 只关心 `opencode-go` provider 的三种鉴权路径：
 *   - `wellknown`：OAuth device flow 拿到的 Bearer token
 *   - `oauth`：access/refresh token 对
 *   - `api`：控制台订阅后拿到的 API key
 */
interface AuthFile {
  [providerId: string]: { type?: string; token?: string; access?: string; key?: string } | unknown;
}

export interface OpencodeToken {
  /** OAuth Bearer token 或控制台 API key */
  accessToken: string;
  /** Account server base URL，默认 `https://opencode.ai`，自建可设 `$OPENCODE_SERVER` */
  baseUrl: string;
}

/**
 * OpenCode Go dashboard 抓取的会话配置。
 * 来源：环境变量 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`（也支持从 `opencode.env` 自动加载）。
 * 这两个值必须从浏览器 DevTools 提取，因为 OpenCode CLI 的 `auth.json` 只保存 API Bearer，不保存 web session。
 */
export interface OpencodeGoConfig {
  workspaceId: string;
  authCookie: string;
}

interface GoUsageError {
  type?: string;
  message?: string;
  metadata?: { limitName?: "5 hour" | "weekly" | "monthly" };
}

interface ScrapedWindow {
  usagePercent: number;
  resetInSec: number;
}

/** `$XDG_DATA_HOME/opencode/auth.json` 路径解析 —— 与 sst/opencode `Global.Path.data` 行为一致 */
function defaultAuthPath(): string {
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "opencode", "auth.json");
}

/**
 * 从 OpenCode CLI 持久化的 `auth.json` 读出 Go 订阅的 Bearer token。
 * 认 `opencode-go` provider 的三种鉴权条目（wellknown / oauth / api）。
 */
export function loadOpencodeToken(authPath = defaultAuthPath()): OpencodeToken {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch (e) {
    throw new OpencodeAuthError(`read ${authPath} failed: ${e instanceof Error ? e.message : e}`, false);
  }

  let parsed: AuthFile;
  try {
    parsed = JSON.parse(raw) as AuthFile;
  } catch (e) {
    throw new OpencodeAuthError(`parse ${authPath}: ${e instanceof Error ? e.message : e}`, false);
  }

  const entry = parsed["opencode-go"] as { type?: string; token?: string; access?: string; key?: string } | undefined;
  if (!entry || typeof entry !== "object") {
    throw new OpencodeAuthError(
      `opencode-go entry not found in ${authPath} — run \`opencode auth login\` and subscribe to Go first`,
      false,
    );
  }
  let accessToken: string | undefined;
  if (entry.type === "wellknown" && typeof entry.token === "string") accessToken = entry.token;
  else if (entry.type === "oauth" && typeof entry.access === "string") accessToken = entry.access;
  else if (entry.type === "api" && typeof entry.key === "string") accessToken = entry.key;
  if (!accessToken) {
    throw new OpencodeAuthError(
      `opencode-go token missing or unsupported type="${entry.type}" in ${authPath}`,
      false,
    );
  }

  const baseUrl = process.env.OPENCODE_SERVER ?? "https://opencode.ai";
  return { accessToken, baseUrl };
}

/** 从环境变量（或自动加载的 `opencode.env`）读 dashboard 抓取配置；任一缺失返回 undefined */
export function loadOpencodeGoConfig(): OpencodeGoConfig | undefined {
  let workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  let authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();

  // 从 `$XDG_CONFIG_HOME/ai-quota/opencode.env` 自动加载（仅当 env 没设；shell-style KEY=VALUE，可带 export）
  if (!workspaceId || !authCookie) {
    const envPath = process.env.OPENCODE_GO_ENV ?? join(homedir(), ".config", "ai-quota", "opencode.env");
    try {
      const raw = readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, key, val] = m;
        const unquoted = val!.replace(/^['"]|['"]$/g, "");
        if (key === "OPENCODE_GO_WORKSPACE_ID" && !workspaceId) workspaceId = unquoted;
        else if (key === "OPENCODE_GO_AUTH_COOKIE" && !authCookie) authCookie = unquoted;
      }
    } catch {
      // 文件不存在/不可读 → 静默回退（与没配 env 一样走 Bearer 兜底）
    }
  }

  if (!workspaceId || !authCookie) return undefined;
  return { workspaceId, authCookie };
}

/* ------------------------------------------------------------------ *
 * Dashboard HTML 解析 —— SolidJS SSR 输出格式：
 *   `rollingUsage:$R[N]={status:"ok",resetInSec:12640,usagePercent:5}`
 *   `weeklyUsage:$R[N]={status:"ok",resetInSec:588526,usagePercent:67.2}`
 * monthly 字段虽然存在但不渲染（控制台单独看），省去解析开销。
 * ------------------------------------------------------------------ */

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
/** 返回两个 RegExp：[usagePercent 在前, resetInSec 在前]，让调用方按命中顺序决定哪个 group 是哪个字段 */
const RE_SSR_WINDOW = (field: string): RegExp[] => [
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\\}`),
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\\}`),
];

const RE_ROLLING = RE_SSR_WINDOW("rollingUsage");
const RE_WEEKLY = RE_SSR_WINDOW("weeklyUsage");

function parseSsrWindow(html: string, patterns: RegExp[]): ScrapedWindow | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    // patterns[0] = usagePercent 在 group[1]；patterns[1] = resetInSec 在 group[1]
    const usagePercent = Number(re === patterns[0] ? m[1] : m[2]);
    const resetInSec = Number(re === patterns[0] ? m[2] : m[1]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec };
  }
  return null;
}

/** 把 rolling/weekly 两窗口归一到单行 ModelRemain（5h → interval、weekly → weekly）。
 *  ponytail: 不支持单字段缺失 —— SSR 是 all-or-nothing，要么三个都有要么全没。 */
function windowsToModelRemains(windows: { rolling: ScrapedWindow; weekly: ScrapedWindow }): ModelRemain[] {
  const now = Date.now();
  const fill = (w: ScrapedWindow): { remaining_percent: number; remains_time: number; end_time: number; status: number } => {
    const usage = Math.max(0, Math.min(100, w.usagePercent));
    const endMs = now + Math.max(0, w.resetInSec) * 1000;
    return {
      remaining_percent: 100 - usage,
      remains_time: Math.max(0, endMs - now),
      end_time: endMs,
      status: usage >= 100 ? 3 : 1,
    };
  };
  return [{ model_name: "opencode-go", interval: fill(windows.rolling), weekly: fill(windows.weekly) }];
}

/** 从 dashboard HTML 抓 rolling/weekly 两窗口的使用率。
 *  cookie 失效 → 302 跳登录页（fetch with `redirect: "manual"` 把跳转换成 status 0 的 opaqueredirect）。 */
export async function scrapeOpencodeGoDashboard(
  cfg: OpencodeGoConfig,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<ModelRemain[]> {
  const baseUrl = opts.baseUrl ?? process.env.OPENCODE_SERVER ?? "https://opencode.ai";
  const url = `${baseUrl}/workspace/${encodeURIComponent(cfg.workspaceId)}/go`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: `auth=${cfg.authCookie}`,
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0",
      },
      signal: ctrl.signal,
      redirect: "manual",
    });
    // opaqueredirect（status 0）+ 直接 401/403 都视为鉴权失败
    if (resp.status === 0 || resp.status === 401 || resp.status === 403) {
      throw new OpencodeAuthError(`dashboard auth failed — refresh \$OPENCODE_GO_AUTH_COOKIE`, false);
    }
    if (!resp.ok) {
      throw new OpencodeAuthError(`dashboard HTTP ${resp.status}`, resp.status >= 500);
    }
    const html = await resp.text();

    const rolling = parseSsrWindow(html, RE_ROLLING);
    const weekly = parseSsrWindow(html, RE_WEEKLY);
    if (!rolling || !weekly) {
      throw new OpencodeAuthError("dashboard parse failed: rolling/weekly usage not found", false);
    }
    return windowsToModelRemains({ rolling, weekly });
  } catch (e) {
    if (e instanceof OpencodeAuthError) throw e;
    throw new OpencodeAuthError(`dashboard: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取 OpenCode Go 配额。两级策略：
 *
 *  1. **dashboard 抓取**（首选）：env 或 `opencode.env` 配了 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`
 *     时，GET workspace dashboard 页面，正则解析 rolling + weekly 两窗口。
 *  2. **Bearer 探活 + 429 捕获**（兜底）：用 auth.json 里的 token 调 `/zen/go/v1/models`。
 *     - 200 → 鉴权 OK 但拿不到剩余 %，返回空数组
 *     - 429 + `error.type: "GoUsageLimitError"` → 解析已耗尽窗口
 *     - 401/403 → 鉴权失败
 */
export async function queryQuota(
  token: OpencodeToken,
  opts: { baseUrl?: string; timeoutMs?: number; retries?: number } = {},
): Promise<QuotaResponse> {
  // 第一级：dashboard 抓取
  const dashCfg = loadOpencodeGoConfig();
  if (dashCfg) {
    const items = await scrapeOpencodeGoDashboard(dashCfg, { baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
    return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: items };
  }

  // 第二级：Bearer 探活
  const baseUrl = opts.baseUrl ?? token.baseUrl;
  const url = `${baseUrl}/zen/go/v1/models`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxAttempts = opts.retries ?? 3;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    Accept: "application/json",
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method: "GET", headers, signal: ctrl.signal, keepalive: true });
      if (resp.status === 429) {
        const body = (await resp.json().catch(() => ({}))) as { error?: GoUsageError };
        const err = body.error ?? {};
        const retryAfterSec = Number(resp.headers.get("retry-after")) || null;
        const limitName = err.metadata?.limitName;
        const remain = limitName ? goErrorToModelRemain(limitName, retryAfterSec) : null;
        if (remain) return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: [remain] };
        throw new OpencodeAuthError(`HTTP 429 ${JSON.stringify(body).slice(0, 200)}`, true);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new OpencodeAuthError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status >= 500);
      }
      return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: [] };
    } catch (e) {
      lastErr = e;
      if (e instanceof OpencodeAuthError && !e.retryable) throw e;
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastErr instanceof Error) {
    const cause = (lastErr as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ? ` (${cause.code}${cause.message ? `: ${cause.message}` : ""})` : "";
    throw new OpencodeAuthError(
      lastErr.name === "AbortError" ? `timeout after ${maxAttempts}x${timeoutMs}ms` : `network: ${lastErr.message}${detail}`,
    );
  }
  throw new OpencodeAuthError(`network: ${String(lastErr)}`);
}

/** 429 错误响应归一化：仅当窗口被命中时返回对应 ModelRemain */
function goErrorToModelRemain(limitName: "5 hour" | "weekly" | "monthly", retryAfterSec: number | null): ModelRemain | null {
  const nowMs = Date.now();
  const resetMs = retryAfterSec !== null && Number.isFinite(retryAfterSec) ? nowMs + retryAfterSec * 1000 : nowMs;
  const exhausted = {
    remaining_percent: 0,
    remains_time: Math.max(0, resetMs - nowMs),
    end_time: resetMs,
    status: 3,
  };
  const active = { remaining_percent: 100, remains_time: Math.max(0, resetMs - nowMs), end_time: resetMs, status: 1 };
  if (limitName === "5 hour") return { model_name: "opencode-go", interval: exhausted, weekly: active };
  return { model_name: "opencode-go", interval: active, weekly: exhausted };
}