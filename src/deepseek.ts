export interface DeepSeekBalanceInfo {
  currency: "CNY" | "USD" | string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

export class DeepSeekUsageError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "DeepSeekUsageError";
  }
}

export async function queryDeepSeekBalance(
  apiKey: string,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<DeepSeekBalanceResponse> {
  const baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;

  try {
    resp = await fetch(`${baseUrl}/user/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new DeepSeekUsageError(
      e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `network: ${e}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new DeepSeekUsageError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status);
  }

  const data = (await resp.json()) as DeepSeekBalanceResponse;
  if (!Array.isArray(data.balance_infos)) throw new DeepSeekUsageError("balance_infos missing in response");
  return data;
}