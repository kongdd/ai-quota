export type Region = "cn" | "intl";

/** 单个模型的 5h 窗口配额信息 */
export interface IntervalQuota {
  /** 剩余百分比 (0–100) */
  remaining_percent: number;
  /** 距窗口结束剩余时间 (ms) */
  remains_time: number;
  /** 窗口结束时间 (epoch ms) */
  end_time: number;
  /** 状态码（1 = 正常, 3 = 已用尽等） */
  status: number;
}

/** 单个模型的 week 窗口配额信息 */
export interface WeeklyQuota {
  remaining_percent: number;
  remains_time: number;
  end_time: number;
  status: number;
}

/** Token Plan 加速倍率（千分之一 permille；2000 表示 x2）。仅 MiniMax 系列可能存在。 */
export interface QuotaBoost {
  /** 5h 窗口加速倍率；≤1000 = 无加速 */
  interval?: number;
  /** 周窗口加速倍率 */
  weekly?: number;
}

export interface ModelRemain {
  model_name: string;
  interval: IntervalQuota;
  weekly: WeeklyQuota;
  /** OpenCode Go：`--long` 无参时第三列月窗口 */
  monthly?: WeeklyQuota;
  balance?: {
    amount: number;
    currency: string;
  };
  /** Token Plan 加速倍率（当前仅 MiniMax 返回） */
  boost?: QuotaBoost;
}

export interface QuotaResponse {
  base_resp: { status_code: number; status_msg?: string };
  model_remains: ModelRemain[];
}

export class QuotaError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "QuotaError";
  }
}

// 注：`/v1/api/openplatform/coding_plan/remains` 旧路径仍被网关接收但返回 `status_code: 1004`，
// 不再返回配额数据。MiniMax 已迁移到 Token Plan，详见 FAQ https://platform.minimaxi.com/docs/token-plan/faq
const ENDPOINTS: Record<Region, string> = {
  cn: "https://api.minimaxi.com/v1/token_plan/remains",
  intl: "https://api.minimax.io/v1/token_plan/remains",
};

/** 原始 API 响应字段（snake_case，外部接口） */
interface RawModelRemain {
  model_name: string;
  current_interval_remaining_percent: number;
  current_interval_status: number;
  remains_time: number;
  end_time: number;
  current_weekly_remaining_percent: number;
  current_weekly_status: number;
  weekly_remains_time: number;
  weekly_end_time: number;
  /** 5h 窗口配额倍率（千分之一，2000 = x2）。缺省表示无加速。 */
  interval_boost_permille?: number;
  /** 周窗口配额倍率（千分之一）。 */
  weekly_boost_permille?: number;
}

/** 将原始字段归一化到内部结构 */
function normalize(raw: RawModelRemain): ModelRemain {
  const out: ModelRemain = {
    model_name: raw.model_name,
    interval: {
      remaining_percent: raw.current_interval_remaining_percent,
      remains_time: raw.remains_time,
      end_time: raw.end_time,
      status: raw.current_interval_status,
    },
    weekly: {
      remaining_percent: raw.current_weekly_remaining_percent,
      remains_time: raw.weekly_remains_time,
      end_time: raw.weekly_end_time,
      status: raw.current_weekly_status,
    },
  };
  // boost 仅在至少一窗口显式返回时才输出；permille ≤ 1000 等价无加速，仍保留原始数值
  if (raw.interval_boost_permille !== undefined || raw.weekly_boost_permille !== undefined) {
    out.boost = {
      interval: raw.interval_boost_permille,
      weekly: raw.weekly_boost_permille,
    };
  }
  return out;
}

export async function queryQuota(
  apiKey: string,
  region: Region,
  groupId?: string,
  timeoutMs = 15_000,
): Promise<QuotaResponse> {
  const url = new URL(ENDPOINTS[region]);
  if (groupId) url.searchParams.set("GroupId", groupId);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new QuotaError(
      e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `network: ${e}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new QuotaError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status);
  }

  const data = (await resp.json()) as { base_resp: QuotaResponse["base_resp"]; model_remains: RawModelRemain[] };
  if (data.base_resp.status_code !== 0) {
    throw new QuotaError(data.base_resp.status_msg ?? `code ${data.base_resp.status_code}`);
  }
  return {
    base_resp: data.base_resp,
    model_remains: data.model_remains.map(normalize),
  };
}
