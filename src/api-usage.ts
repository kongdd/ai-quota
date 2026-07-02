#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { queryDeepSeekBalance, DeepSeekUsageError, type DeepSeekBalanceInfo } from "./deepseek.js";

const HELP = `api-usage — API account balance and daily budget progress

Usage: api-usage [options]

First run each day records the current account balance as today's baseline; later runs compute
"today used = baseline − current balance".

Examples:
  api-usage                          # default daily budget: 5 CNY
  api-usage --budget 10              # set daily budget to 10 CNY
  api-usage --watch -i 30s           # refresh every 30s
  api-usage --reset-today            # restart today's budget window

Options:
      --provider <deepseek>      API provider (default: deepseek)
      --budget <AMOUNT>         Daily budget amount (default: 5)
      --currency <CNY|USD>      Balance currency to display (default: CNY)
      --reset-today             Reset today's baseline to current account balance
      --reset                   Alias for --reset-today
      --config <PATH>           Budget state file (default: ~/.config/ai-quota/api-usage.json)
  -w, --watch                   Refresh in place until Ctrl+C (implied by --interval)
  -i, --interval <SECS>         Watch refresh interval (30/30s/1m, default 60)
  -h, --help                    Show this help

Requires: DEEPSEEK_API_KEY env.
`;

interface DayState {
  baseline_balance: number;
  created_at: string;
}

interface BudgetState {
  provider: "deepseek";
  currency: string;
  days: Record<string, DayState>;
}

interface UsageSnapshot {
  provider: "deepseek";
  currency: string;
  day: string;
  accountBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
  isAvailable: boolean;
  dailyBudget: number;
  baselineBalance: number;
  todayUsed: number;
  todayLeft: number;
  todayUsedPercent: number;
  baselineCreatedAt: string;
  statePath: string;
  resetToday: boolean;
}

const useColor =
  !!process.env.FORCE_COLOR ||
  (!process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY);
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36);

function die(msg: string): never {
  process.stderr.write(`api-usage: ${msg}\n`);
  process.exit(2);
  throw new Error(msg);
}

function defaultStatePath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-quota", "api-usage.json");
}

function parseNonNegativeMoney(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === "") die(`${name} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) die(`${name} must be a non-negative number`);
  return n;
}

function parsePositiveMoney(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === "") die(`${name} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) die(`${name} must be > 0`);
  return n;
}

function parseInterval(s: string): number {
  const m = /^(\d+)\s*(s|m)?$/.exec(s.trim());
  if (!m) die(`--interval must be a positive number (e.g. 30, 30s, 1m)`);
  const n = Number(m[1]);
  if (n < 1) die(`--interval must be >= 1s`);
  return n * (m[2] === "m" ? 60_000 : 1_000);
}

function fmtInterval(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

function localDay(d = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyState(currency: string): BudgetState {
  return { provider: "deepseek", currency, days: {} };
}

function loadState(path: string, currency: string): BudgetState {
  if (!existsSync(path)) return emptyState(currency);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetState>;
  if (parsed.provider !== "deepseek" || typeof parsed.currency !== "string" || !parsed.days) {
    return emptyState(currency);
  }
  const state: BudgetState = {
    provider: "deepseek",
    currency: parsed.currency,
    days: parsed.days,
  };
  if (state.currency.toUpperCase() !== currency.toUpperCase()) return emptyState(currency);
  return state;
}

function saveState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function pickBalance(infos: DeepSeekBalanceInfo[], currency: string): DeepSeekBalanceInfo {
  const exact = infos.find((x) => x.currency.toUpperCase() === currency.toUpperCase());
  if (exact) return exact;
  const available = infos.map((x) => x.currency).join(", ") || "none";
  die(`currency ${currency} not found in balance_infos; available: ${available}`);
}

function money(n: number, currency: string): string {
  const symbol = currency.toUpperCase() === "CNY" ? "¥" : currency.toUpperCase() === "USD" ? "$" : `${currency} `;
  return `${symbol}${n.toFixed(4)}`;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtTime(epochMs = Date.now()): string {
  return new Date(epochMs).toLocaleString("sv-SE", { hour12: false });
}

function bar(usedPercent: number, w = 24): string {
  const p = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.max(0, Math.min(w, Math.round((p / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

function colorFor(usedPercent: number) {
  return usedPercent < 50 ? green : usedPercent < 80 ? yellow : red;
}

function formatError(e: unknown): string {
  if (e instanceof DeepSeekUsageError) return e.status ? `${e.status}: ${e.message}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

async function snapshot(values: Record<string, unknown>): Promise<UsageSnapshot> {
  const provider = (values.provider as string | undefined) ?? "deepseek";
  if (provider !== "deepseek") die(`--provider must be deepseek`);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) die(`API key required: set DEEPSEEK_API_KEY env`);

  const currency = ((values.currency as string | undefined) ?? process.env.DEEPSEEK_CURRENCY ?? "CNY").toUpperCase();
  const dailyBudget = parsePositiveMoney(
    (values.budget as string | undefined) ?? process.env.DEEPSEEK_DAILY_BUDGET ?? process.env.DEEPSEEK_BUDGET ?? "5",
    "--budget",
  );

  const statePath = (values.config as string | undefined) ?? defaultStatePath();
  const resetToday = values["reset-today"] === true || values.reset === true;
  const day = localDay();

  const data = await queryDeepSeekBalance(apiKey);
  const info = pickBalance(data.balance_infos, currency);
  const accountBalance = parseNonNegativeMoney(info.total_balance, "total_balance");
  const grantedBalance = parseNonNegativeMoney(info.granted_balance, "granted_balance");
  const toppedUpBalance = parseNonNegativeMoney(info.topped_up_balance, "topped_up_balance");

  const state = loadState(statePath, currency);
  let dayState = state.days[day];
  if (!dayState || resetToday) {
    dayState = { baseline_balance: accountBalance, created_at: new Date().toISOString() };
    state.days[day] = dayState;
  }
  state.currency = currency;
  saveState(statePath, state);

  const todayUsed = Math.max(0, dayState.baseline_balance - accountBalance);
  const todayLeft = Math.max(0, dailyBudget - todayUsed);
  const todayUsedPercent = Math.min(100, (todayUsed / dailyBudget) * 100);

  return {
    provider: "deepseek",
    currency,
    day,
    accountBalance,
    grantedBalance,
    toppedUpBalance,
    isAvailable: data.is_available,
    dailyBudget,
    baselineBalance: dayState.baseline_balance,
    todayUsed,
    todayLeft,
    todayUsedPercent,
    baselineCreatedAt: dayState.created_at,
    statePath,
    resetToday,
  };
}

function render(s: UsageSnapshot): string {
  const color = colorFor(s.todayUsedPercent);
  const lines = [
    fmtTime(),
    `  provider       ${cyan(s.provider)}`,
    `  account        ${money(s.accountBalance, s.currency)} total  (${money(s.grantedBalance, s.currency)} granted + ${money(s.toppedUpBalance, s.currency)} topped-up)`,
    `  daily budget   ${money(s.todayLeft, s.currency)} left / ${money(s.dailyBudget, s.currency)}  ${color(bar(s.todayUsedPercent))} ${color(pct(s.todayUsedPercent))} used`,
    `  today spent    ${money(s.todayUsed, s.currency)} since ${s.day}`,
    `  day baseline   ${money(s.baselineBalance, s.currency)}  ${dim(s.baselineCreatedAt)}`,
    `  state          ${dim(s.statePath)}`,
    `  available      ${s.isAvailable ? green("yes") : red("no")}`,
  ];
  if (s.resetToday) lines.push(dim("  today's baseline reset to current account balance"));
  if (s.accountBalance > s.baselineBalance) {
    lines.push(dim("  note           account balance increased after today's baseline; balance-delta usage is clamped at 0"));
  }
  return lines.join("\n");
}

async function runWatch(values: Record<string, unknown>, intervalMs: number): Promise<void> {
  const isTty = !!process.stdout.isTTY;
  let lastLines = 0;
  let timer: NodeJS.Timeout | undefined;
  const watchValues = { ...values };
  const hint = () => dim(`watch · refresh every ${fmtInterval(intervalMs)} · Ctrl+C to stop`);

  const writeFrame = (body: string) => {
    const out = body.endsWith("\n") ? body : body + "\n";
    if (isTty && lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`);
    process.stdout.write(out);
    lastLines = out.split("\n").length - 1;
  };

  const tick = async () => {
    try {
      const frame = render(await snapshot(watchValues));
      watchValues["reset-today"] = false;
      watchValues.reset = false;
      writeFrame(`${hint()}\n${frame}`);
    } catch (e) {
      writeFrame(`${hint()}\napi-usage: ${formatError(e)}`);
    }
    timer = setTimeout(tick, intervalMs);
  };

  process.on("SIGINT", () => {
    if (timer) clearTimeout(timer);
    process.stdout.write("\n");
    process.exit(0);
  });
  await tick();
}

async function main(): Promise<void> {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      options: {
        provider: { type: "string" },
        budget: { type: "string" },
        currency: { type: "string" },
        "reset-today": { type: "boolean" },
        reset: { type: "boolean" },
        config: { type: "string" },
        watch: { type: "boolean", short: "w" },
        interval: { type: "string", short: "i" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }) as { values: Record<string, unknown> });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    die(`${msg}\n\n${HELP}`);
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values.watch || values.interval !== undefined) {
    await runWatch(values, parseInterval((values.interval as string | undefined) ?? "60"));
    return;
  }

  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  try {
    process.stdout.write(render(await snapshot(values)) + "\n");
  } catch (e) {
    die(formatError(e));
  }
}

void main();
