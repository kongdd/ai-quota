import { piAgentAuthPath, readJsonFile, readPiAuthEntry } from "../auth.js";
import { env, existsSync, fetchQuota, homedir, join, randomUUID } from "../platform.js";
import type { IntervalQuota, ModelRemain, QuotaResponse } from "./minimax.js";

export class CodexAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "CodexAuthError";
  }
}

/**
 * 解析后的 Codex CLI 鉴权信息 —— 来自 `~/.codex/auth.json`。
 * 字段镜像 openai/codex `codex-rs/login/src/auth/storage.rs` 的 `AuthDotJson`。
 * 只取 ChatGPT OAuth 模式（`auth_mode === "chatgpt"` + `tokens`）的子集。
 */
interface AuthDotJson {
  auth_mode?: "apikey" | "chatgpt" | string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexToken {
  /** ChatGPT OAuth JWT */
  accessToken: string;
  /** ChatGPT 账户 ID（可选；后端用来关联账户） */
  accountId?: string;
}

interface WhamWindow {
  used_percent: number;
  remaining_percent?: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

interface WhamResponse {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  /** 可选的共享池；当前 Pi 应用额度需另查 /usage/chatpass/apps。 */
  chatpass?: { windows?: WhamWindow[] };
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: WhamWindow;
    secondary_window?: WhamWindow;
  };
}

export interface CodexResetCredit {
  status?: string;
  grantedAt?: string;
  expiresAt?: string;
  title?: string;
}

export interface CodexResetCredits {
  availableCount: number;
  credits: CodexResetCredit[];
}

interface ResetCreditResponse {
  available_count?: number;
  credits?: Array<{
    status?: string;
    granted_at?: string;
    expires_at?: string;
    title?: string;
  }>;
}

/** `~/.codex/auth.json` 路径 —— `$CODEX_HOME` 未设置时回退到 `~/.codex/`（与 codex-rs 默认行为一致） */
function defaultAuthPath(): string {
  const home = env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "auth.json");
}

/** 从 pi agent auth.json 的 `openai-codex` 条目读 Codex OAuth token（access + accountId）。 */
function loadCodexTokenFromPiAuth(authPath = piAgentAuthPath()): CodexToken | undefined {
  const e = readPiAuthEntry("openai-codex", authPath);
  if (!e || (e.type !== undefined && e.type !== "oauth")) return undefined;
  const raw = e.access ?? e.access_token ?? e.token;
  const accessToken = typeof raw === "string" ? raw.trim() : "";
  if (!accessToken) return undefined;
  const token: CodexToken = { accessToken };
  const idRaw = e.accountId ?? e.account_id;
  const accountId = typeof idRaw === "string" ? idRaw.trim() : "";
  if (accountId) token.accountId = accountId;
  return token;
}

/** 新版 Pi OAuth 仅提供本地应用匹配信息，绝不发送到 ChatGPT 后端。 */
function loadOpenaiClientId(): string | undefined {
  const entry = readPiAuthEntry("openai");
  if (entry?.type !== "oauth") return undefined;
  const raw = entry.access ?? entry.access_token ?? entry.token;
  if (typeof raw !== "string") return undefined;
  try {
    const parts = raw.trim().split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
      iss?: string;
      aud?: string;
      scope?: string;
      client_id?: string;
    };
    if (
      claims.iss !== "https://auth.openai.com" || claims.aud !== "https://api.openai.com/v1"
      || typeof claims.scope !== "string" || !claims.scope.split(/\s+/).includes("chatgpt.tokens.use.direct")
      || typeof claims.client_id !== "string" || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(claims.client_id)
    ) return undefined;
    return claims.client_id;
  } catch {
    return undefined;
  }
}

/**
 * 从 Codex CLI 持久化的 auth.json 读出 ChatGPT OAuth JWT。
 * 优先 pi agent auth.json 的 `openai-codex` 条目，再回退到 `$CODEX_HOME/auth.json`（ChatGPT 模式）；
 * 新版 pi `openai` OAuth 面向 api.openai.com，不能用于 WHAM；仅有新版凭据时给出明确提示。
 * 缺失 tokens 时报错（API key 模式不返回 quota 窗口结构，跳过）。
 */
export function loadCodexToken(authPath = defaultAuthPath()): CodexToken {
  // 旧版 OAuth 的刷新仍交由 pi / Codex 管理；不修改共享凭据。
  const fromPi = loadCodexTokenFromPiAuth();
  if (fromPi) return fromPi;

  if (!existsSync(authPath) && readPiAuthEntry("openai")?.type === "oauth") {
    throw new CodexAuthError(
      "Pi OpenAI (Sign in with ChatGPT) OAuth cannot read ChatGPT usage; "
      + "sign in with Codex / pi OpenAI Codex (legacy) for Codex and shared-app quota, "
      + "or see https://chatgpt.com/settings/usage",
      false,
    );
  }

  let parsed: AuthDotJson;
  try {
    parsed = readJsonFile<AuthDotJson>(authPath);
  } catch (e) {
    throw new CodexAuthError(`${authPath}: ${e instanceof Error ? e.message : e}`, false);
  }

  if (parsed.auth_mode && parsed.auth_mode !== "chatgpt") {
    throw new CodexAuthError(`auth_mode=${parsed.auth_mode}, only "chatgpt" exposes quota windows`, false);
  }
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) throw new CodexAuthError(`tokens.access_token missing in ${authPath}`, false);
  const accountId = parsed.tokens?.account_id;
  return accountId ? { accessToken, accountId } : { accessToken };
}

/**
 * 构造"伪装成 Codex CLI"的请求 header 集。
 * 字段来源：openai/codex `codex-rs/core/src/client_common.rs`。
 * 后端依据这些 header 识别 Codex 流量并把 ChatGPT 订阅 quota（而不是普通 API key 计费）路由到本次请求。
 * 重要：base URL 是 `chatgpt.com/backend-api/...`（不是 api.openai.com）—— 后者是 OpenAI API 网关，
 * 会以 401 "Missing scopes" 拒绝 ChatGPT Plus JWT。
 */
function buildCodexHeaders(token: CodexToken): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    "User-Agent": "codex_cli_rs/0.0.0",
    "OpenAI-Beta": "responses_websockets=2026-02-06",
    "session-id": randomUUID(),
    "thread-id": randomUUID(),
    Accept: "application/json",
  };
  if (token.accountId) headers["chatgpt-account-id"] = token.accountId;
  return headers;
}

/** 查询 Codex 可按需使用的限额重置卡。 */
export async function queryResetCredits(
  token: CodexToken,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<CodexResetCredits> {
  const baseUrl = opts.baseUrl ?? "https://chatgpt.com";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);

  try {
    const resp = await fetchQuota(`${baseUrl}/backend-api/wham/rate-limit-reset-credits`, {
      headers: buildCodexHeaders(token),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new CodexAuthError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status === 429);
    }

    const data = (await resp.json()) as ResetCreditResponse;
    const credits = (data.credits ?? []).map((c) => ({
      status: c.status,
      grantedAt: c.granted_at,
      expiresAt: c.expires_at,
      title: c.title,
    }));
    const count = Number(data.available_count);
    return {
      availableCount: Number.isFinite(count)
        ? Math.max(0, Math.trunc(count))
        : credits.filter((c) => (c.status ?? "available") === "available").length,
      credits,
    };
  } catch (e) {
    if (e instanceof CodexAuthError) throw e;
    throw new CodexAuthError(e instanceof Error && e.name === "AbortError"
      ? `timeout after ${opts.timeoutMs ?? 30_000}ms`
      : `network: ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
}

/** WHAM 的 reset_at 是 epoch 秒；不存在的窗口不补造额度。 */
function whamWindowQuota(window?: WhamWindow): IntervalQuota | undefined {
  if (!window || !Number.isFinite(window.used_percent) || !Number.isFinite(window.reset_at)) return undefined;
  if (window.remaining_percent !== undefined && !Number.isFinite(window.remaining_percent)) return undefined;
  const endTime = window.reset_at * 1000;
  return {
    remaining_percent: Math.max(0, Math.min(100, window.remaining_percent ?? 100 - window.used_percent)),
    remains_time: Math.max(0, endTime - Date.now()),
    end_time: endTime,
    status: window.used_percent >= 100 ? 3 : 1,
  };
}

function whamToModelRemain(
  name: string,
  primary?: WhamWindow,
  secondary?: WhamWindow,
): ModelRemain | null {
  const interval = whamWindowQuota(primary);
  const weekly = whamWindowQuota(secondary);
  if (!interval && !weekly) return null;
  return { model_name: name, ...(interval && { interval }), ...(weekly && { weekly }) };
}

/**
 * 拉 ChatGPT 后端的配额数据：`GET https://chatgpt.com/backend-api/wham/usage`。
 * 有新版 Pi OAuth 时另查 `/usage/chatpass/apps`，按 client_id 唯一匹配当前应用。
 * 仅只读 GET、零推理消耗；不会刷新或改写共享凭据。
 * 需要 ChatGPT OAuth JWT + Codex-style headers 才能通过后端鉴权。
 */
export async function queryQuota(
  token: CodexToken,
  opts: { baseUrl?: string; timeoutMs?: number; retries?: number } = {},
): Promise<QuotaResponse> {
  const baseUrl = opts.baseUrl ?? "https://chatgpt.com";
  const url = `${baseUrl}/backend-api/wham/usage`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxAttempts = opts.retries ?? 3;
  // undici 的 connect timeout 是 10s 硬编码；用 retry 容忍 Cloudflare 偶发 connect timeout
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const headers = { ...buildCodexHeaders(token), "OAI-App-Brand": "chatgpt" };
  const clientId = loadOpenaiClientId();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchQuota(url, {
        method: "GET",
        headers,
        signal: ctrl.signal,
        keepalive: true,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        // 429 是限流而非鉴权失败，让 watch 模式走指数退避而不是直接退出
        throw new CodexAuthError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status === 429);
      }
      const data = (await resp.json()) as WhamResponse;
      const modelName = data.plan_type ? `codex · ${data.plan_type === "prolite" ? "pro" : data.plan_type}` : "codex";
      const primary = data.rate_limit?.primary_window;
      const codex = whamToModelRemain(modelName, primary, data.rate_limit?.secondary_window ?? primary);
      let windows = Array.isArray(data.chatpass?.windows) ? data.chatpass.windows : [];
      if (clientId) {
        const appResp = await fetchQuota(`${url}/chatpass/apps`, {
          headers,
          signal: ctrl.signal,
          redirect: "error",
        });
        if (!appResp.ok) {
          throw new CodexAuthError(`OpenAI apps usage HTTP ${appResp.status}`, appResp.status === 429 || appResp.status >= 500);
        }
        const appData = await appResp.json() as {
          items?: Array<{ id?: string; windows?: WhamWindow[] }>;
        } | null;
        const matches = Array.isArray(appData?.items) ? appData.items.filter((app) => app?.id === clientId) : [];
        if (matches.length !== 1) {
          throw new CodexAuthError("OpenAI app not uniquely found; sign in to Pi OpenAI and Codex with the same ChatGPT account/workspace", false);
        }
        windows = Array.isArray(matches[0]?.windows) ? matches[0].windows : [];
      }
      // ponytail: 支持当前 5h / 周额度；出现其他周期时扩展窗口映射。
      const apps = whamToModelRemain(
        "openai · apps",
        windows.find((w) => w?.limit_window_seconds === 5 * 60 * 60),
        windows.find((w) => w?.limit_window_seconds === 7 * 24 * 60 * 60),
      );
      if (clientId && !apps) throw new CodexAuthError("OpenAI app usage has no supported quota windows", false);
      const models = [codex, apps].filter((m): m is ModelRemain => m !== null);
      if (!models.length) throw new CodexAuthError("quota windows missing in response", false);
      return {
        base_resp: { status_code: 0, status_msg: "ok" },
        model_remains: models,
      };
    } catch (e) {
      lastErr = e;
      // 业务错误（HTTP 4xx/5xx、缺字段）不重试；只重试网络/超时
      if (e instanceof CodexAuthError && !e.retryable) throw e;
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  // 全部重试都失败
  if (lastErr instanceof Error) {
    const cause = (lastErr as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ? ` (${cause.code}${cause.message ? `: ${cause.message}` : ""})` : "";
    throw new CodexAuthError(
      lastErr.name === "AbortError" ? `timeout after ${maxAttempts}x${timeoutMs}ms` : `network: ${lastErr.message}${detail}`,
    );
  }
  throw new CodexAuthError(`network: ${String(lastErr)}`);
}