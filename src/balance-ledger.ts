import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY_MS = 86_400_000;

export interface LedgerRecord {
  baseline_balance: number;
  created_at: string;
  spent?: number;
  last_balance?: number;
  updated_at?: string;
}

export interface BalanceLedgerState {
  provider: string;
  currency: string;
  dailyBudget: number;
  weeklyBudget: number;
  last_balance?: number;
  updated_at?: string;
  days: Record<string, LedgerRecord>;
  weeks: Record<string, LedgerRecord>;
}

export interface UsageProgress {
  used: number;
  left: number;
  percent: number;
}

export interface LedgerUpdate {
  day: string;
  week: string;
  weekStart: string;
  dayRecord: LedgerRecord;
  weekRecord: LedgerRecord;
  today: UsageProgress;
  weekUsage: UsageProgress;
}

export function defaultLedgerPath(file = "api-usage.json"): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-quota", file);
}

export function emptyLedgerState(
  provider: string,
  currency: string,
  dailyBudget: number,
  weeklyBudget: number,
): BalanceLedgerState {
  return { provider, currency, dailyBudget, weeklyBudget, days: {}, weeks: {} };
}

export function readLedgerState(
  path: string,
  opts: { provider: string; aliases?: string[]; defaultDailyBudget: number; defaultWeeklyBudget: number },
): BalanceLedgerState | undefined {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BalanceLedgerState> & { provider?: string };
  if (![opts.provider, ...(opts.aliases ?? [])].includes(raw.provider ?? "") || typeof raw.currency !== "string" || !raw.days) {
    return undefined;
  }
  return {
    provider: opts.provider,
    currency: raw.currency,
    dailyBudget: positiveOr(raw.dailyBudget, opts.defaultDailyBudget),
    weeklyBudget: positiveOr(raw.weeklyBudget, opts.defaultWeeklyBudget),
    last_balance: finiteNumber(raw.last_balance),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    days: raw.days,
    weeks: raw.weeks ?? {},
  };
}

export function saveLedgerState(path: string, state: BalanceLedgerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function resolveBudget(raw: string | undefined, envKeys: string[], saved: number, name: string): number {
  const value = raw ?? envKeys.map((k) => process.env[k]).find(Boolean) ?? String(saved);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be > 0`);
  return n;
}

export function recordBalanceUsage(
  state: BalanceLedgerState,
  opts: { balance: number; now: Date; reset: boolean; dailyBudget: number; weeklyBudget: number },
): LedgerUpdate {
  const previousBalance = state.last_balance;
  const delta = opts.reset || previousBalance === undefined ? 0 : Math.max(0, previousBalance - opts.balance);
  const day = localDay(opts.now);
  const week = isoWeek(opts.now);
  const weekStart = weekStartDay(opts.now);

  state.dailyBudget = opts.dailyBudget;
  state.weeklyBudget = opts.weeklyBudget;
  state.last_balance = opts.balance;
  state.updated_at = opts.now.toISOString();

  const dayRecord = updateRecord(state.days, day, opts.balance, opts.now, opts.reset, delta, previousBalance === undefined);
  const weekRecord = updateRecord(state.weeks, week, opts.balance, opts.now, opts.reset, delta, previousBalance === undefined);
  if (previousBalance === undefined) {
    migrateLegacyRecord(dayRecord, opts.balance);
    migrateLegacyRecord(weekRecord, opts.balance);
  }

  return {
    day,
    week,
    weekStart,
    dayRecord,
    weekRecord,
    today: progress(dayRecord, opts.dailyBudget),
    weekUsage: progress(weekRecord, opts.weeklyBudget),
  };
}

export function windowEnd(now: Date, weekly = false): number {
  const d = new Date(now);
  if (weekly) d.setDate(d.getDate() + (8 - (d.getDay() || 7)));
  d.setHours(weekly ? 0 : 24, 0, 0, 0);
  return d.getTime();
}

function positiveOr(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteNumber(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
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

function weekStartDay(d: Date): string {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() || 7) - 1));
  return localDay(x);
}

function updateRecord(
  record: Record<string, LedgerRecord>,
  key: string,
  value: number,
  now: Date,
  reset: boolean,
  delta: number,
  migrateFromBaseline: boolean,
): LedgerRecord {
  const ts = now.toISOString();
  const state = record[key];
  if (!state || reset) {
    return (record[key] = { baseline_balance: value + delta, created_at: ts, spent: delta, last_balance: value, updated_at: ts });
  }

  if (state.spent === undefined) state.spent = migrateFromBaseline ? Math.max(0, state.baseline_balance - value) : 0;
  state.spent += delta;
  state.last_balance = value;
  state.updated_at = ts;
  return state;
}

function migrateLegacyRecord(state: LedgerRecord, value: number): void {
  if (state.spent === undefined) state.spent = Math.max(0, state.baseline_balance - value);
}

function progress(state: LedgerRecord, limit: number): UsageProgress {
  const used = Math.max(0, state.spent ?? 0);
  return { used, left: Math.max(0, limit - used), percent: Math.min(100, (used / limit) * 100) };
}
