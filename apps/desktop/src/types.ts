export const PROVIDERS = [
  "minimax",
  "openai",
  "claude",
  "opencode",
  "deepseek-api",
  "grok",
  "kimi",
  "zhipu",
] as const;

export type Provider = (typeof PROVIDERS)[number];
export type QuotaPeriod = "short" | "daily" | "weekly" | "monthly";

export interface QuotaWindow {
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string;
  resetsInMs: number;
  status: "available" | "exhausted";
}

export interface QuotaModel {
  name: string;
  windows: Partial<Record<QuotaPeriod, QuotaWindow>>;
  balance?: { amount: number; currency: string };
  boostPermille?: { short?: number; weekly?: number };
}

export interface ApiError {
  code: "auth" | "config" | "network" | "timeout" | "upstream" | "unknown";
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export type ProviderSnapshot =
  | { provider: Provider; status: "ok"; models: QuotaModel[] }
  | { provider: Provider; status: "error"; error: ApiError };

export interface QuotaSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  status: "ok" | "partial" | "error";
  providers: ProviderSnapshot[];
}
