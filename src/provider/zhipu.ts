import type { ModelRemain, QuotaResponse, WeeklyQuota } from "./minimax.js";

/** 区域：cn = 国内 bigmodel.cn，intl = 国际 z.ai */
export type Region = "cn" | "intl";

export class ZhipuError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ZhipuError";
  }
}

const ENDPOINTS: Record<Region, string> = {
  cn: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  intl: "https://api.z.ai/api/monitor/usage/quota/limit",
};

interface RawLimit {
  type: string;
  /** TOKENS_LIMIT：已用百分比 */
  percentage?: number;
  /** 下次重置时间戳（毫秒） */
  nextResetTime?: number;
  /** TIME_LIMIT：剩余 / 已用 / 周期总数（次数） */
  remaining?: number;
  currentValue?: number;
  usage?: number;
}

interface RawResponse {
  success?: boolean;
  msg?: string;
  code?: string | number;
  data?: {
    limits: RawLimit[];
    /** 套餐等级：lite / pro / max */
    level?: string;
  };
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** MCP 月度按"次数"计量，把 remaining/currentValue/usage 归一成已用百分比。 */
function mcpUsedPercent(l: RawLimit): number {
  const used = finite(l.currentValue) ? Math.max(0, l.currentValue) : 0;
  const remain = finite(l.remaining) ? Math.max(0, l.remaining) : 0;
  const total = finite(l.usage) && l.usage > 0 ? l.usage : used + remain;
  return total > 0 ? Math.min(100, (used / total) * 100) : 0;
}

/** 本月 1 号 0:00 的 epoch ms（本地时区）。MCP 月度 resetTime 兜底。 */
function nextMonthStart(now: Date): number {
  const d = new Date(now);
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function quota(used: number, endMs: number, now: number): WeeklyQuota {
  return {
    remaining_percent: Math.max(0, 100 - used),
    remains_time: Math.max(0, endMs - now),
    end_time: endMs,
    status: used >= 100 ? 3 : 1,
  };
}

export interface ZhipuQueryOptions {
  timeoutMs?: number;
  /** 团队版需要，从 `bigmodel.cn/coding-plan/team/usage-stats` 网络请求复制 */
  organization?: string;
  project?: string;
}

/** `ZHIPU_CN_API_KEY` 优先，缺省回退 `ZHIPU_API_KEY`（国际同形 / 兼容） */
export function resolveZhipuApiKey(): string | undefined {
  return process.env.ZHIPU_CN_API_KEY ?? process.env.ZHIPU_API_KEY;
}

/**
 * 拉取智谱 GLM 编码套餐 5h + 周配额；可选 MCP 月度作第三列。
 *
 *   cn: `open.bigmodel.cn/api/monitor/usage/quota/limit`
 *   intl: `api.z.ai/api/monitor/usage/quota/limit`
 *
 * 响应 `limits: [TOKENS_LIMIT, TOKENS_LIMIT, TIME_LIMIT?]`，分别对齐 interval / weekly / monthly。
 * 老套餐可能只返回一个 TOKENS_LIMIT（仅 5h），周窗口降级到 5h。`nextResetTime` 缺失时按 5h 兜底，
 * 避免 renderReport 出现负数。团队版需要 `bigmodel-organization` + `bigmodel-project` header。
 */
export async function queryQuota(
  apiKey: string,
  region: Region,
  opts: ZhipuQueryOptions = {},
): Promise<QuotaResponse> {
  if (!apiKey) {
    throw new ZhipuError("API key required: set ZHIPU_CN_API_KEY or ZHIPU_API_KEY env", 401);
  }

  const headers: Record<string, string> = { Authorization: apiKey, Accept: "application/json" };
  if (opts.organization) headers["bigmodel-organization"] = opts.organization;
  if (opts.project) headers["bigmodel-project"] = opts.project;

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(ENDPOINTS[region], { method: "GET", headers, signal: ctrl.signal });
  } catch (e) {
    throw new ZhipuError(
      e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `network: ${e}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ZhipuError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status);
  }

  const raw = (await resp.json()) as RawResponse;
  if (raw.success === false) throw new ZhipuError(raw.msg ?? `code ${raw.code ?? "unknown"}`);
  const limits = raw.data?.limits;
  if (!Array.isArray(limits) || limits.length === 0) throw new ZhipuError("data.limits missing or empty");

  // 按 nextResetTime 升序 → [5h, week]；老套餐可能只返回 5h
  const tokens = limits.filter((l) => l.type === "TOKENS_LIMIT");
  const sortedTokens = [...tokens].sort((a, b) => (finite(a.nextResetTime) ? a.nextResetTime : Infinity) - (finite(b.nextResetTime) ? b.nextResetTime : Infinity));
  const mcp = limits.find((l) => l.type === "TIME_LIMIT");

  const now = Date.now();
  const intervalEnd = (sortedTokens[0] && finite(sortedTokens[0].nextResetTime) ? sortedTokens[0].nextResetTime : now + 5 * 3_600_000)!;
  const weeklyEnd = (sortedTokens[1] && finite(sortedTokens[1].nextResetTime) ? sortedTokens[1].nextResetTime : intervalEnd)!;

  const level = raw.data?.level ?? "unknown";
  const out: ModelRemain = {
    model_name: level === "unknown" ? "zhipu" : `zhipu-${level}`,
    interval: quota(sortedTokens[0]?.percentage ?? 0, intervalEnd, now),
    // 老套餐无 weekly 数据时降级到 5h 的百分比，避免表格第二列空白
    weekly: quota(sortedTokens[1]?.percentage ?? sortedTokens[0]?.percentage ?? 0, weeklyEnd, now),
  };
  if (mcp) {
    out.monthly = quota(
      mcpUsedPercent(mcp),
      finite(mcp.nextResetTime) && mcp.nextResetTime > now ? mcp.nextResetTime : nextMonthStart(new Date(now)),
      now,
    );
  }

  return {
    base_resp: { status_code: 0, status_msg: "ok" },
    model_remains: [out],
  };
}
