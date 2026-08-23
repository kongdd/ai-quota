import { readJsonFile } from "../core-auth.js";
import { env, fetchQuota, homedir, join } from "../platform.js";
import type { ModelRemain, QuotaResponse } from "./minimax.js";

export class ClaudeAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

/**
 * 解析后的 Claude Code 鉴权信息 —— 来自 `~/.claude/.credentials.json`。
 * 字段镜像 `@anthropic-ai/claude-code` 持久化的 OAuth 结构。
 */
interface CredentialsJson {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
  organizationUuid?: string;
}

export interface ClaudeToken {
  /** Claude Code OAuth access token (`sk-ant-oat01-…`) */
  accessToken: string;
  /** 订阅类型（`pro` / `max` / `team` / `free` 等），用于显示 */
  subscriptionType?: string;
}

interface UsageWindow {
  /** 已用百分比 (0–100) */
  utilization?: number;
  /** 重置时间（ISO 8601） */
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  extra_usage?: {
    is_enabled?: boolean;
    utilization?: number;
    used_credits?: number;
    monthly_limit?: number;
  };
}

/** `~/.claude/.credentials.json` 路径 —— `$CLAUDE_CONFIG_DIR` 未设置时回退到 `~/.claude/` */
function defaultAuthPath(): string {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(home, ".credentials.json");
}

/**
 * 从 Claude Code 持久化的 `.credentials.json` 读出 OAuth access token。
 */
export function loadClaudeToken(authPath = defaultAuthPath()): ClaudeToken {
  let parsed: CredentialsJson;
  try {
    parsed = readJsonFile<CredentialsJson>(authPath);
  } catch (e) {
    throw new ClaudeAuthError(`${authPath}: ${e instanceof Error ? e.message : e}`, false);
  }
  const accessToken = parsed.claudeAiOauth?.accessToken;
  if (!accessToken) throw new ClaudeAuthError(`claudeAiOauth.accessToken missing in ${authPath}`, false);
  const subscriptionType = parsed.claudeAiOauth?.subscriptionType;
  return subscriptionType ? { accessToken, subscriptionType } : { accessToken };
}

/**
 * 构造调用 OAuth usage 端点的请求 header 集。
 * `anthropic-beta: oauth-2025-04-20` 是该端点要求的 beta 头；缺失会被网关拒绝。
 * 端点来源：anthropics/claude-code 内部 oauth usage 调用（由 aweussom/claude-code-quota 反向验证）。
 */
function buildClaudeHeaders(token: ClaudeToken): Record<string, string> {
  return {
    Authorization: `Bearer ${token.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  };
}

/** 把 ISO 8601 时间戳解析为 epoch ms；解析失败返回 null */
function parseResetMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 把 usage 响应里的窗口数据归一化到内部 ModelRemain（5h / week） */
function usageToModelRemain(u: UsageResponse, modelName: string): ModelRemain | null {
  const fiveHour = u.five_hour;
  if (fiveHour?.utilization === undefined) return null;
  const sevenDay = u.seven_day;

  const nowMs = Date.now();
  const fiveUtil = fiveHour.utilization;
  const fiveEndMs = parseResetMs(fiveHour.resets_at) ?? (fiveUtil === 0 ? nowMs : null);
  const sevenEndMs = parseResetMs(sevenDay?.resets_at) ?? fiveEndMs;
  if (fiveEndMs === null) return null;

  const sevenUtil = sevenDay?.utilization ?? fiveUtil;

  return {
    model_name: modelName,
    interval: {
      remaining_percent: Math.max(0, 100 - fiveUtil),
      remains_time: Math.max(0, fiveEndMs - nowMs),
      end_time: fiveEndMs,
      status: fiveUtil >= 100 ? 3 : 1,
    },
    weekly: {
      remaining_percent: Math.max(0, 100 - sevenUtil),
      remains_time: Math.max(0, (sevenEndMs ?? fiveEndMs) - nowMs),
      end_time: sevenEndMs ?? fiveEndMs,
      status: sevenUtil >= 100 ? 3 : 1,
    },
  };
}

/**
 * 拉取 Claude Code 的配额数据：`GET https://api.anthropic.com/api/oauth/usage`。
 * 一次 HTTP GET、零消耗、零副作用。需要 OAuth access token + `anthropic-beta: oauth-2025-04-20` 才能通过鉴权。
 */
export async function queryQuota(
  token: ClaudeToken,
  opts: { baseUrl?: string; timeoutMs?: number; retries?: number } = {},
): Promise<QuotaResponse> {
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  const url = `${baseUrl}/api/oauth/usage`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxAttempts = opts.retries ?? 3;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const headers = buildClaudeHeaders(token);
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
        throw new ClaudeAuthError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status === 429);
      }
      const data = (await resp.json()) as UsageResponse;
      const modelName = token.subscriptionType ? `claude · ${token.subscriptionType}` : "claude";
      const modelRemain = usageToModelRemain(data, modelName);
      if (!modelRemain) {
        throw new ClaudeAuthError("five_hour.utilization missing in response", false);
      }
      return {
        base_resp: { status_code: 0, status_msg: "ok" },
        model_remains: [modelRemain],
      };
    } catch (e) {
      lastErr = e;
      // 业务错误（HTTP 4xx/5xx、缺字段）不重试；只重试网络/超时
      if (e instanceof ClaudeAuthError && !e.retryable) throw e;
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastErr instanceof Error) {
    const cause = (lastErr as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ? ` (${cause.code}${cause.message ? `: ${cause.message}` : ""})` : "";
    throw new ClaudeAuthError(
      lastErr.name === "AbortError" ? `timeout after ${maxAttempts}x${timeoutMs}ms` : `network: ${lastErr.message}${detail}`,
    );
  }
  throw new ClaudeAuthError(`network: ${String(lastErr)}`);
}
