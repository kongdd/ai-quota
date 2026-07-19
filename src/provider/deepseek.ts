import {
  defaultLedgerPath,
  emptyLedgerState,
  readLedgerState,
  recordBalanceUsage,
  resolveBudget,
  saveLedgerState,
  windowEnd,
} from "../balance-ledger.js";
import type { ModelRemain } from "./minimax.js";

const API = "https://api.deepseek.com";
const DEFAULT_DAILY = 7;
const DEFAULT_WEEKLY = 35;
const DEFAULT_MONTHLY = 70;

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

export class DeepSeekUsageError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "DeepSeekUsageError";
  }
}

export interface DeepseekComputeOptions {
  apiKey: string;
  currency?: string;
  dailyBudget?: string;
  weeklyBudget?: string;
  monthlyBudget?: string;
  resetToday?: boolean;
  configPath?: string;
  now?: Date;
}

export interface DeepseekComputeResult {
  modelRemains: ModelRemain[];
  detail: {
    provider: "deepseek-api";
    currency: string;
    day: string;
    week: string;
    weekStart: string;
    accountBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
    isAvailable: boolean;
    dailyBudget: number;
    weeklyBudget: number;
    monthlyBudget: number;
    baselineBalance: number;
    weekBaselineBalance: number;
    monthBaselineBalance: number;
    todayUsed: number;
    todayLeft: number;
    todayUsedPercent: number;
    weekUsed: number;
    weekLeft: number;
    weekUsedPercent: number;
    monthUsed: number;
    monthLeft: number;
    monthUsedPercent: number;
    month: string;
    monthStart: string;
    baselineCreatedAt: string;
    weekBaselineCreatedAt: string;
    monthBaselineCreatedAt: string;
    statePath: string;
    resetToday: boolean;
  };
}

export function defaultStatePath(): string {
  return defaultLedgerPath("api-usage.json");
}

async function queryBalance(apiKey: string, timeoutMs = 15_000): Promise<BalanceResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new DeepSeekUsageError(`HTTP ${resp.status} ${body.slice(0, 200)}`, resp.status);
    }
    const data = (await resp.json()) as BalanceResponse;
    if (!Array.isArray(data.balance_infos)) throw new DeepSeekUsageError("balance_infos missing in response");
    return data;
  } catch (e) {
    if (e instanceof DeepSeekUsageError) throw e;
    throw new DeepSeekUsageError(e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `network: ${e}`);
  } finally {
    clearTimeout(timer);
  }
}

function money(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new DeepSeekUsageError(`${name} must be a non-negative number`);
  return n;
}

function balanceInfo(data: BalanceResponse, currency: string): BalanceInfo {
  const info = data.balance_infos.find((x) => x.currency.toUpperCase() === currency);
  if (info) return info;
  const available = data.balance_infos.map((x) => x.currency).join(", ") || "none";
  throw new DeepSeekUsageError(`currency ${currency} not found in balance_infos; available: ${available}`);
}

function budget(raw: string | undefined, envKeys: string[], saved: number, name: string): number {
  try {
    return resolveBudget(raw, envKeys, saved, name);
  } catch (e) {
    throw new DeepSeekUsageError(e instanceof Error ? e.message : String(e));
  }
}

function quota(usedPercent: number, endTime: number, nowMs: number) {
  return {
    remaining_percent: Math.max(0, 100 - usedPercent),
    remains_time: Math.max(0, endTime - nowMs),
    end_time: endTime,
    status: usedPercent >= 100 ? 3 : 1,
  };
}

export async function computeDeepseekUsage(opts: DeepseekComputeOptions): Promise<DeepseekComputeResult> {
  if (!opts.apiKey) throw new DeepSeekUsageError("API key required: set DEEPSEEK_API_KEY env");

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const statePath = opts.configPath ?? defaultStatePath();
  const savedState = readLedgerState(statePath, {
    provider: "deepseek-api",
    aliases: ["deepseek"],
    defaultDailyBudget: DEFAULT_DAILY,
    defaultWeeklyBudget: DEFAULT_WEEKLY,
    defaultMonthlyBudget: DEFAULT_MONTHLY,
  });
  const currency = (opts.currency ?? process.env.DEEPSEEK_CURRENCY ?? savedState?.currency ?? "CNY").toUpperCase();
  const state = savedState?.currency.toUpperCase() === currency
    ? savedState
    : emptyLedgerState("deepseek-api", currency, DEFAULT_DAILY, DEFAULT_WEEKLY, DEFAULT_MONTHLY);
  const dailyBudget = budget(opts.dailyBudget, ["DEEPSEEK_DAILY_BUDGET", "DEEPSEEK_BUDGET"], state.dailyBudget, "--budget");
  const weeklyBudget = budget(opts.weeklyBudget, ["DEEPSEEK_WEEKLY_BUDGET"], state.weeklyBudget, "--weekly-budget");
  const monthlyBudget = budget(opts.monthlyBudget, ["DEEPSEEK_MONTHLY_BUDGET"], state.monthlyBudget, "--monthly-budget");
  const resetToday = opts.resetToday === true;

  const data = await queryBalance(opts.apiKey);
  const info = balanceInfo(data, currency);
  const accountBalance = money(info.total_balance, "total_balance");
  const grantedBalance = money(info.granted_balance, "granted_balance");
  const toppedUpBalance = money(info.topped_up_balance, "topped_up_balance");

  state.currency = currency;
  const usage = recordBalanceUsage(state, {
    balance: accountBalance,
    now,
    reset: resetToday,
    dailyBudget,
    weeklyBudget,
    monthlyBudget,
  });
  saveLedgerState(statePath, state);

  const modelRemains: ModelRemain[] = [{
    model_name: "deepseek",
    interval: quota(usage.today.percent, windowEnd(now, "day"), nowMs),
    weekly: quota(usage.weekUsage.percent, windowEnd(now, "week"), nowMs),
    monthly: quota(usage.monthUsage.percent, windowEnd(now, "month"), nowMs),
    balance: { amount: accountBalance, currency },
  }];

  return {
    modelRemains,
    detail: {
      provider: "deepseek-api",
      currency,
      day: usage.day,
      week: usage.week,
      weekStart: usage.weekStart,
      accountBalance,
      grantedBalance,
      toppedUpBalance,
      isAvailable: data.is_available,
      dailyBudget,
      weeklyBudget,
      monthlyBudget,
      baselineBalance: usage.dayRecord.baseline_balance,
      weekBaselineBalance: usage.weekRecord.baseline_balance,
      monthBaselineBalance: usage.monthRecord.baseline_balance,
      todayUsed: usage.today.used,
      todayLeft: usage.today.left,
      todayUsedPercent: usage.today.percent,
      weekUsed: usage.weekUsage.used,
      weekLeft: usage.weekUsage.left,
      weekUsedPercent: usage.weekUsage.percent,
      monthUsed: usage.monthUsage.used,
      monthLeft: usage.monthUsage.left,
      monthUsedPercent: usage.monthUsage.percent,
      month: usage.month,
      monthStart: usage.monthStart,
      baselineCreatedAt: usage.dayRecord.created_at,
      weekBaselineCreatedAt: usage.weekRecord.created_at,
      monthBaselineCreatedAt: usage.monthRecord.created_at,
      statePath,
      resetToday,
    },
  };
}
