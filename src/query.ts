import process from "node:process";
import { KNOWN_PROVIDERS, isEnabled, loadAuthConfig, loadPiAuthKey, type KnownProvider } from "./auth.js";
import {
  parseOpencodeGoLongPeriod,
  resolveOpencodeGoLongWindowForQuery,
} from "./opencode-config.js";
import { queryQuota as queryMinimax, resolveMinimaxApiKey, type ModelRemain, type Region } from "./provider/minimax.js";
import {
  loadCodexToken,
  queryQuota as queryOpenai,
  queryResetCredits,
  type CodexResetCredit,
} from "./provider/openai.js";
import { loadClaudeToken, queryQuota as queryClaude } from "./provider/claude.js";
import { queryQuota as queryOpencode } from "./provider/opencode.js";
import { computeDeepseekUsage, defaultStatePath } from "./provider/deepseek.js";
import { queryQuota as queryGrok } from "./provider/grok.js";
import { queryQuota as queryKimi, resolveKimiApiKey } from "./provider/kimi.js";
import { queryQuota as queryZhipu, resolveZhipuApiKey, ZhipuError, type Region as ZhipuRegion } from "./provider/zhipu.js";

export type Provider = KnownProvider;
export type QueryValues = Record<string, unknown>;
type Runner = (values: QueryValues) => Promise<ModelRemain[]>;

export type QueryResult =
  | { name: Provider; ok: true; items: ModelRemain[] }
  | { name: Provider; ok: false; error: unknown };

export type QuotaPeriod = "short" | "daily" | "weekly" | "monthly";

export interface QuotaWindowSnapshot {
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string;
  resetsInMs: number;
  status: "available" | "exhausted";
}

export interface QuotaModelSnapshot {
  name: string;
  windows: Partial<Record<QuotaPeriod, QuotaWindowSnapshot>>;
  balance?: { amount: number; currency: string };
  boostPermille?: { short?: number; weekly?: number };
}

export interface QuotaErrorSnapshot {
  code: "auth" | "config" | "network" | "timeout" | "upstream" | "unknown";
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export type ProviderSnapshot =
  | { provider: Provider; status: "ok"; models: QuotaModelSnapshot[] }
  | { provider: Provider; status: "error"; error: QuotaErrorSnapshot };

export interface QuotaSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  status: "ok" | "partial" | "error";
  providers: ProviderSnapshot[];
}

export type CodexResetSnapshot =
  | {
      schemaVersion: 1;
      generatedAt: string;
      provider: "openai";
      status: "ok";
      availableCount: number;
      credits: CodexResetCredit[];
    }
  | {
      schemaVersion: 1;
      generatedAt: string;
      provider: "openai";
      status: "error";
      error: QuotaErrorSnapshot;
    };

function displayName(name: string): string {
  if (name === "general" || name === "MiniMax") return "minimax";
  return name;
}

async function runMinimax(values: QueryValues): Promise<ModelRemain[]> {
  const region = (values.region ?? "cn") as Region;
  if (region !== "cn" && region !== "intl") throw new Error("--region must be cn or intl");
  const key = resolveMinimaxApiKey(region);
  if (!key) throw new Error("API key required: set MINIMAX_CN_API_KEY or MINIMAX_API_KEY env, or add to ~/.pi/agent/auth.json");
  return (await queryMinimax(key, region)).model_remains;
}

async function runOpenai(values: QueryValues): Promise<ModelRemain[]> {
  return (await queryOpenai(loadCodexToken(values["codex-auth"] as string | undefined))).model_remains;
}

async function runClaude(values: QueryValues): Promise<ModelRemain[]> {
  return (await queryClaude(loadClaudeToken(values["claude-auth"] as string | undefined))).model_remains;
}

function opencodeLongWindow(values: QueryValues) {
  const raw = values.long as string | undefined;
  return resolveOpencodeGoLongWindowForQuery(raw ? parseOpencodeGoLongPeriod(raw) : undefined);
}

async function runOpencode(values: QueryValues): Promise<ModelRemain[]> {
  if (values["opencode-long-all"] === true) return (await queryOpencode({ allWindows: true })).model_remains;
  return (await queryOpencode({ longWindow: opencodeLongWindow(values) })).model_remains;
}

async function runDeepseek(values: QueryValues): Promise<ModelRemain[]> {
  const apiKey = loadPiAuthKey("deepseek") ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("API key required: set DEEPSEEK_API_KEY env, or add to ~/.pi/agent/auth.json");
  return (await computeDeepseekUsage({
    apiKey,
    currency: values.currency as string | undefined,
    dailyBudget: (values["deepseek-daily-budget"] ?? values.budget) as string | undefined,
    weeklyBudget: (values["deepseek-weekly-budget"] ?? values["weekly-budget"]) as string | undefined,
    monthlyBudget: (values["deepseek-monthly-budget"] ?? values["monthly-budget"]) as string | undefined,
    resetToday: values["reset-today"] === true || values.reset === true,
    configPath: ((values["deepseek-config"] ?? values.config) as string | undefined) ?? defaultStatePath(),
  })).modelRemains;
}

async function runGrok(): Promise<ModelRemain[]> {
  return (await queryGrok()).model_remains;
}

async function runKimi(): Promise<ModelRemain[]> {
  const key = resolveKimiApiKey();
  if (!key) throw new Error("API key required: set KIMI_API_KEY or MOONSHOT_API_KEY env");
  return (await queryKimi(key)).model_remains;
}

async function runZhipu(values: QueryValues): Promise<ModelRemain[]> {
  const key = resolveZhipuApiKey();
  if (!key) throw new ZhipuError("API key required: set ZHIPU_CN_API_KEY or ZHIPU_API_KEY env", 401);
  const region = (values["zhipu-region"] ?? "cn") as string;
  if (region !== "cn" && region !== "intl") throw new ZhipuError("--zhipu-region must be cn or intl");
  return (await queryZhipu(key, region as ZhipuRegion, {
    organization: values["zhipu-org"] as string | undefined,
    project: values["zhipu-project"] as string | undefined,
  })).model_remains;
}

const RUNNERS: Record<Provider, Runner> = {
  minimax: runMinimax,
  openai: runOpenai,
  claude: runClaude,
  opencode: runOpencode,
  "deepseek-api": runDeepseek,
  grok: runGrok,
  kimi: runKimi,
  zhipu: runZhipu,
};

export function enabledProviders(): Provider[] {
  const config = loadAuthConfig();
  return KNOWN_PROVIDERS.filter((provider) => isEnabled(config, provider));
}

export function parseProviders(raw: string): Provider[] {
  const providers = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  const invalid = providers.find((provider) => !(KNOWN_PROVIDERS as readonly string[]).includes(provider));
  if (invalid) throw new Error(`unknown provider: ${invalid}`);
  if (providers.length === 0) throw new Error("providers must not be empty");
  return providers as Provider[];
}

export async function runQuotaQuery(
  providers: Provider[],
  values: QueryValues = {},
  runners: Record<Provider, Runner> = RUNNERS,
): Promise<QueryResult[]> {
  const settled = await Promise.allSettled(providers.map((provider) => runners[provider](values)));
  return providers.map((name, index): QueryResult => {
    const result = settled[index]!;
    return result.status === "fulfilled"
      ? { name, ok: true, items: result.value }
      : { name, ok: false, error: result.reason };
  });
}

function windowSnapshot(window: ModelRemain["interval"], now: number): QuotaWindowSnapshot {
  const remainingPercent = Math.max(0, Math.min(100, window.remaining_percent));
  return {
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetsAt: new Date(window.end_time).toISOString(),
    resetsInMs: Math.max(0, window.end_time - now),
    status: remainingPercent > 0 && window.status !== 3 ? "available" : "exhausted",
  };
}

function modelPeriods(provider: Provider, model: ModelRemain, values: QueryValues) {
  if (provider === "deepseek-api") return { interval: "daily", weekly: "weekly", monthly: "monthly" } as const;
  if (provider === "grok") return { interval: "weekly", weekly: "monthly", monthly: "monthly" } as const;
  if (provider === "opencode" && !model.monthly) {
    return { interval: "short", weekly: opencodeLongWindow(values), monthly: "monthly" } as const;
  }
  return { interval: "short", weekly: "weekly", monthly: "monthly" } as const;
}

function modelSnapshot(model: ModelRemain, provider: Provider, now: number, values: QueryValues): QuotaModelSnapshot {
  const periods = modelPeriods(provider, model, values);
  const windows: Partial<Record<QuotaPeriod, QuotaWindowSnapshot>> = {
    [periods.interval]: windowSnapshot(model.interval, now),
    [periods.weekly]: windowSnapshot(model.weekly, now),
  };
  if (model.monthly) windows[periods.monthly] = windowSnapshot(model.monthly, now);

  const snapshot: QuotaModelSnapshot = {
    name: displayName(model.model_name),
    windows,
  };
  if (model.balance) snapshot.balance = model.balance;
  if (model.boost) snapshot.boostPermille = {
    ...(model.boost.interval !== undefined ? { short: model.boost.interval } : {}),
    ...(model.boost.weekly !== undefined ? { weekly: model.boost.weekly } : {}),
  };
  return snapshot;
}

export function errorSnapshot(error: unknown): QuotaErrorSnapshot {
  const value = error as { message?: unknown; status?: unknown; retryable?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = typeof value?.status === "number" ? value.status : undefined;
  const lower = message.toLowerCase();
  const code = httpStatus === 401 || httpStatus === 403 || /api key required|credentials?.*(missing|not found)|token.*missing|auth_mode/.test(lower)
    ? "auth"
    : /timeout|timed out/.test(lower)
      ? "timeout"
      : /network|fetch failed|connect/.test(lower)
        ? "network"
        : httpStatus !== undefined
          ? "upstream"
          : /read .*failed|parse .*|must be|unknown provider/.test(lower)
            ? "config"
            : "unknown";
  const retryable = typeof value?.retryable === "boolean"
    ? value.retryable
    : code === "network" || code === "timeout" || httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500);
  return {
    code,
    message,
    retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

export function quotaSnapshot(results: QueryResult[], now = Date.now(), values: QueryValues = {}): QuotaSnapshot {
  const config = loadAuthConfig();
  const providers = results.map((result): ProviderSnapshot => {
    if (!result.ok) return { provider: result.name, status: "error", error: errorSnapshot(result.error) };
    const models = result.items.map((model) => modelSnapshot(model, result.name, now, values));
    return { provider: result.name, status: "ok", models };
  });
  const succeeded = providers.filter((provider) => provider.status === "ok").length;
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    status: succeeded === 0 ? "error" : succeeded === providers.length ? "ok" : "partial",
    providers,
  };
}

export async function queryQuotaSnapshot(
  options: { providers?: Provider[]; values?: QueryValues; now?: number } = {},
): Promise<QuotaSnapshot> {
  const { providers = enabledProviders(), values = {}, now } = options;
  return quotaSnapshot(await runQuotaQuery(providers, values), now, values);
}

export async function queryCodexResetSnapshot(
  options: { authPath?: string; now?: number } = {},
): Promise<CodexResetSnapshot> {
  const generatedAt = new Date(options.now ?? Date.now()).toISOString();
  try {
    const data = await queryResetCredits(loadCodexToken(options.authPath));
    return {
      schemaVersion: 1,
      generatedAt,
      provider: "openai",
      status: "ok",
      availableCount: data.availableCount,
      credits: data.credits,
    };
  } catch (cause) {
    return {
      schemaVersion: 1,
      generatedAt,
      provider: "openai",
      status: "error",
      error: errorSnapshot(cause),
    };
  }
}
