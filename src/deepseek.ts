import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRemain } from "./minimax.js";

const API = "https://api.deepseek.com";
const DEFAULT_DAILY = 7;
const DEFAULT_WEEKLY = 35;
const DAY_MS = 86_400_000;

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

interface BaselineState {
  baseline_balance: number;
  created_at: string;
}

interface BudgetState {
  provider: "deepseek-api";
  currency: string;
  dailyBudget: number;
  weeklyBudget: number;
  days: Record<string, BaselineState>;
  weeks: Record<string, BaselineState>;
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

export function defaultStatePath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-quota", "api-usage.json");
}

const emptyState = (currency: string): BudgetState => ({
  provider: "deepseek-api",
  currency,
  dailyBudget: DEFAULT_DAILY,
  weeklyBudget: DEFAULT_WEEKLY,
  days: {},
  weeks: {},
});

const validPositive = (n: unknown, fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;

function loadState(path: string, currency: string): BudgetState {
  if (!existsSync(path)) return emptyState(currency);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetState> & { provider?: string };
  if ((raw.provider !== "deepseek-api" && raw.provider !== "deepseek") || typeof raw.currency !== "string" || !raw.days) {
    return emptyState(currency);
  }
  if (raw.currency.toUpperCase() !== currency.toUpperCase()) return emptyState(currency);
  return {
    provider: "deepseek-api",
    currency: raw.currency,
    dailyBudget: validPositive(raw.dailyBudget, DEFAULT_DAILY),
    weeklyBudget: validPositive(raw.weeklyBudget, DEFAULT_WEEKLY),
    days: raw.days,
    weeks: raw.weeks ?? {},
  };
}

function saveState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
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

function budget(raw: string | undefined, envKeys: string[], saved: number, name: string): number {
  const value = raw ?? envKeys.map((k) => process.env[k]).find(Boolean) ?? String(saved);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new DeepSeekUsageError(`${name} must be > 0`);
  return n;
}

function balanceInfo(data: BalanceResponse, currency: string): BalanceInfo {
  const info = data.balance_infos.find((x) => x.currency.toUpperCase() === currency);
  if (info) return info;
  const available = data.balance_infos.map((x) => x.currency).join(", ") || "none";
  throw new DeepSeekUsageError(`currency ${currency} not found in balance_infos; available: ${available}`);
}

function localDay(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoWeek(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function windowEnd(now: Date, weekly = false): number {
  const d = new Date(now);
  if (weekly) d.setDate(d.getDate() + (8 - (d.getDay() || 7)));
  d.setHours(weekly ? 0 : 24, 0, 0, 0);
  return d.getTime();
}

function baseline(record: Record<string, BaselineState>, key: string, value: number, now: Date, reset: boolean): BaselineState {
  return record[key] && !reset ? record[key] : (record[key] = { baseline_balance: value, created_at: now.toISOString() });
}

function spent(base: number, current: number, limit: number) {
  const used = Math.max(0, base - current);
  return { used, left: Math.max(0, limit - used), percent: Math.min(100, (used / limit) * 100) };
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
  const currency = (opts.currency ?? process.env.DEEPSEEK_CURRENCY ?? "CNY").toUpperCase();
  const statePath = opts.configPath ?? defaultStatePath();
  const state = loadState(statePath, currency);
  const dailyBudget = budget(opts.dailyBudget, ["DEEPSEEK_DAILY_BUDGET", "DEEPSEEK_BUDGET"], state.dailyBudget, "--budget");
  const weeklyBudget = budget(opts.weeklyBudget, ["DEEPSEEK_WEEKLY_BUDGET"], state.weeklyBudget, "--weekly-budget");
  const resetToday = opts.resetToday === true;

  const data = await queryBalance(opts.apiKey);
  const info = balanceInfo(data, currency);
  const accountBalance = money(info.total_balance, "total_balance");
  const grantedBalance = money(info.granted_balance, "granted_balance");
  const toppedUpBalance = money(info.topped_up_balance, "topped_up_balance");

  state.currency = currency;
  state.dailyBudget = dailyBudget;
  state.weeklyBudget = weeklyBudget;
  const day = localDay(now);
  const week = isoWeek(now);
  const dayState = baseline(state.days, day, accountBalance, now, resetToday);
  const weekState = baseline(state.weeks, week, accountBalance, now, resetToday);
  saveState(statePath, state);

  const today = spent(dayState.baseline_balance, accountBalance, dailyBudget);
  const wk = spent(weekState.baseline_balance, accountBalance, weeklyBudget);
  const modelRemains: ModelRemain[] = [{
    model_name: "deepseek-api",
    interval: quota(today.percent, windowEnd(now), nowMs),
    weekly: quota(wk.percent, windowEnd(now, true), nowMs),
    balance: { amount: accountBalance, currency },
  }];

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
