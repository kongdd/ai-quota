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

export interface ModelRemain {
  model_name: string;
  interval: IntervalQuota;
  weekly: WeeklyQuota;
  balance?: {
    amount: number;
    currency: string;
  };
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

const ENDPOINTS: Record<Region, string> = {
  cn: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  intl: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
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
}

/** 将原始字段归一化到内部结构 */
function normalize(raw: RawModelRemain): ModelRemain {
  return {
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
