import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRemain } from "./minimax.js";

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

// ───── Shared budget state ─────
// 同时被 `api-usage`（独立 CLI）和 `ai-quota`（统一渲染）使用。

export interface BaselineState {
  baseline_balance: number;
  created_at: string;
}

export interface BudgetState {
  provider: "deepseek-api";
  currency: string;
  dailyBudget: number; // 持久化：避免每次都重复传 --budget / DEEPSEEK_DAILY_BUDGET
  weeklyBudget: number; // 持久化：周预算，与其他 coding plan 展示对齐
  days: Record<string, BaselineState>;
  weeks: Record<string, BaselineState>;
}

export function defaultStatePath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-quota", "api-usage.json");
}

export function localDay(d = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** ISO 8601 周编号（周一为周首），形如 "2026-W27"。 */
export function isoWeekKey(d = new Date()): string {
  // ISO 把周首定义为该周星期四所在的 ISO 周
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7; // Sun=0 → 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function emptyState(currency: string): BudgetState {
  return { provider: "deepseek-api", currency, dailyBudget: 7, weeklyBudget: 35, days: {}, weeks: {} };
}

export function loadDeepseekState(path: string, currency: string): BudgetState {
  if (!existsSync(path)) return emptyState(currency);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetState> & { weeks?: Record<string, BaselineState> };
  // 兼容旧格式 "deepseek" → 迁移到 "deepseek-api"
  if (parsed.provider !== "deepseek-api" && parsed.provider !== "deepseek") return emptyState(currency);
  if (typeof parsed.currency !== "string" || !parsed.days) return emptyState(currency);
  const state: BudgetState = {
    provider: "deepseek-api",
    currency: parsed.currency,
    dailyBudget: typeof parsed.dailyBudget === "number" && parsed.dailyBudget > 0 ? parsed.dailyBudget : 7,
    weeklyBudget: typeof parsed.weeklyBudget === "number" && parsed.weeklyBudget > 0 ? parsed.weeklyBudget : 35,
    days: parsed.days,
    weeks: parsed.weeks ?? {},
  };
  if (state.currency.toUpperCase() !== currency.toUpperCase()) return emptyState(currency);
  return state;
}

export function saveDeepseekState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function pickBalanceOrThrow(infos: DeepSeekBalanceInfo[], currency: string): DeepSeekBalanceInfo {
  const exact = infos.find((x) => x.currency.toUpperCase() === currency.toUpperCase());
  if (exact) return exact;
  const available = infos.map((x) => x.currency).join(", ") || "none";
  throw new DeepSeekUsageError(`currency ${currency} not found in balance_infos; available: ${available}`);
}

function parseNonNegativeMoney(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new DeepSeekUsageError(`${name} must be a non-negative number`);
  return n;
}

function parsePositiveMoney(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new DeepSeekUsageError(`${name} must be > 0`);
  return n;
}

/** 当前本地日 24:00:00.000 的 epoch ms（= 明天 00:00 本地）。 */
export function endOfLocalDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** 当前 ISO 周 24:00:00.000 的 epoch ms（= 下个周一 00:00 本地）。 */
export function endOfIsoWeek(now = new Date()): number {
  const d = new Date(now);
  const isoDow = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1, ..., Sun=7
  d.setDate(d.getDate() + (8 - isoDow)); // days until next Monday
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 预算解析优先级：override > env > state（已持久化）> 默认 7/35 */
function resolveBudget(
  override: string | undefined,
  envKeys: string[],
  stateDefault: number,
  flagName: string,
): number {
  const raw = override ?? envKeys.map((k) => process.env[k]).find((v) => v !== undefined) ?? String(stateDefault);
  return parsePositiveMoney(raw, flagName);
}

function ensureBaseline(
  record: Record<string, BaselineState>,
  key: string,
  accountBalance: number,
  now: Date,
  reset: boolean,
): BaselineState {
  let state = record[key];
  if (!state || reset) {
    state = { baseline_balance: accountBalance, created_at: now.toISOString() };
    record[key] = state;
  }
  return state;
}

function budgetUsed(baseline: number, current: number, budget: number) {
  const used = Math.max(0, baseline - current);
  const left = Math.max(0, budget - used);
  const percent = Math.min(100, (used / budget) * 100);
  return { used, left, percent };
}

export interface DeepseekComputeOptions {
  apiKey: string;
  /** "CNY" | "USD" — display only; uses DEEPSEEK_CURRENCY env if not given */
  currency?: string;
  /** Override daily budget (e.g. CLI flag). Falls back to env / state / default. */
  dailyBudget?: string;
  /** Override weekly budget. */
  weeklyBudget?: string;
  /** Reset both baselines to current balance for today/this-week. */
  resetToday?: boolean;
  /** Override state file path. */
  configPath?: string;
  /** Override "now" — useful for tests. */
  now?: Date;
}

/** 一次 `computeDeepseekUsage` 的完整结果：给 ai-quota 渲染 ModelRemain[]，给 api-usage 渲染 detail。 */
export interface DeepseekComputeResult {
  /** ai-quota 用的 ModelRemain[]（interval = daily，weekly = weekly），单条 deepseek-api。 */
  modelRemains: ModelRemain[];
  /** detail fields 给 api-usage CLI 用。 */
  detail: {
    provider: "deepseek-api";
    currency: string;
    day: string;
    week: string;
    accountBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
    isAvailable: boolean;
    dailyBudget: number;
    weeklyBudget: number;
    baselineBalance: number;
    weekBaselineBalance: number;
    todayUsed: number;
    todayLeft: number;
    todayUsedPercent: number;
    weekUsed: number;
    weekLeft: number;
    weekUsedPercent: number;
    baselineCreatedAt: string;
    weekBaselineCreatedAt: string;
    statePath: string;
    resetToday: boolean;
  };
}

/** 共用入口：拉一次余额、按需记录 day/week 基线、算两条 ModelRemain + detail。 */
export async function computeDeepseekUsage(opts: DeepseekComputeOptions): Promise<DeepseekComputeResult> {
  if (!opts.apiKey) throw new DeepSeekUsageError("API key required: set DEEPSEEK_API_KEY env");
  const now = opts.now ?? new Date();
  const currency = (opts.currency ?? process.env.DEEPSEEK_CURRENCY ?? "CNY").toUpperCase();
  const statePath = opts.configPath ?? defaultStatePath();
  const state = loadDeepseekState(statePath, currency);

  const dailyBudget = resolveBudget(
    opts.dailyBudget,
    ["DEEPSEEK_DAILY_BUDGET", "DEEPSEEK_BUDGET"],
    state.dailyBudget,
    "--budget",
  );
  state.dailyBudget = dailyBudget;

  const weeklyBudget = resolveBudget(
    opts.weeklyBudget,
    ["DEEPSEEK_WEEKLY_BUDGET"],
    state.weeklyBudget,
    "--weekly-budget",
  );
  state.weeklyBudget = weeklyBudget;

  const resetToday = opts.resetToday === true;
  const day = localDay(now);
  const week = isoWeekKey(now);

  const data = await queryDeepSeekBalance(opts.apiKey);
  const info = pickBalanceOrThrow(data.balance_infos, currency);
  const accountBalance = parseNonNegativeMoney(info.total_balance, "total_balance");
  const grantedBalance = parseNonNegativeMoney(info.granted_balance, "granted_balance");
  const toppedUpBalance = parseNonNegativeMoney(info.topped_up_balance, "topped_up_balance");

  const dayState = ensureBaseline(state.days, day, accountBalance, now, resetToday);
  const weekState = ensureBaseline(state.weeks, week, accountBalance, now, resetToday);
  state.currency = currency;
  saveDeepseekState(statePath, state);

  const today = budgetUsed(dayState.baseline_balance, accountBalance, dailyBudget);
  const wk = budgetUsed(weekState.baseline_balance, accountBalance, weeklyBudget);

  const dailyEnd = endOfLocalDay(now);
  const weeklyEnd = endOfIsoWeek(now);

  const modelRemains: ModelRemain[] = [
    {
      model_name: "deepseek-api",
      interval: {
        remaining_percent: Math.max(0, 100 - today.percent),
        remains_time: Math.max(0, dailyEnd - now.getTime()),
        end_time: dailyEnd,
        status: today.percent >= 100 ? 3 : 1,
      },
      weekly: {
        remaining_percent: Math.max(0, 100 - wk.percent),
        remains_time: Math.max(0, weeklyEnd - now.getTime()),
        end_time: weeklyEnd,
        status: wk.percent >= 100 ? 3 : 1,
      },
    },
  ];

  return {
    modelRemains,
    detail: {
      provider: "deepseek-api",
      currency,
      day,
      week,
      accountBalance,
      grantedBalance,
      toppedUpBalance,
      isAvailable: data.is_available,
      dailyBudget,
      weeklyBudget,
      baselineBalance: dayState.baseline_balance,
      weekBaselineBalance: weekState.baseline_balance,
      todayUsed: today.used,
      todayLeft: today.left,
      todayUsedPercent: today.percent,
      weekUsed: wk.used,
      weekLeft: wk.left,
      weekUsedPercent: wk.percent,
      baselineCreatedAt: dayState.created_at,
      weekBaselineCreatedAt: weekState.created_at,
      statePath,
      resetToday,
    },
  };
}