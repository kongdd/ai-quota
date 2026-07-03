#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { computeDeepseekUsage, DeepSeekUsageError, defaultStatePath, type DeepseekComputeResult } from "./provider/deepseek.js";

const HELP = `api-usage — deepseek-api balance, daily & weekly budget progress

Usage: api-usage [options]

First run each day/week records a baseline. Later runs accumulate balance drops into
daily/weekly spent; top-ups do not reduce already recorded usage.

Examples:
  api-usage                          # default daily 7 / weekly 35 CNY
  api-usage --budget 10              # override daily budget to 10 CNY
  api-usage --weekly-budget 50       # override weekly budget to 50 CNY
  api-usage --watch -i 30s           # refresh every 30s
  api-usage --reset-today            # restart today's + this week's budget window

Options:
      --provider <deepseek-api>  API provider (default: deepseek-api)
      --budget <AMOUNT>         Daily budget amount (default: 7; persisted to state file once set)
      --weekly-budget <AMOUNT>  Weekly budget amount (default: 35; persisted to state file once set)
      --currency <CNY|USD>      Balance currency to display (default: CNY)
      --reset-today             Reset today's + this week's baseline to current account balance
      --reset                   Alias for --reset-today
      --config <PATH>           Budget state file (default: ~/.config/ai-quota/api-usage.json)
  -w, --watch                   Refresh in place until Ctrl+C (implied by --interval)
  -i, --interval <SECS>         Watch refresh interval (30/30s/1m, default 60)
  -h, --help                    Show this help

Requires: DEEPSEEK_API_KEY env.
`;

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

function money(n: number, currency: string): string {
  const symbol = currency.toUpperCase() === "CNY" ? "¥ " : currency.toUpperCase() === "USD" ? "$ " : `${currency} `;
  return `${symbol}${n.toFixed(2)}`;
}

function alignedMoney(n: number, currency: string, width: number): string {
  const code = currency.toUpperCase();
  const symbol = code === "CNY" ? "¥ " : code === "USD" ? "$ " : `${code} `;
  return `${symbol}${n.toFixed(2).padStart(width)}`;
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

/** Compute → translate to CLI view → return the same UsageSnapshot shape the render expects. */
async function snapshot(values: Record<string, unknown>): Promise<DeepseekComputeResult["detail"]> {
  const provider = (values.provider as string | undefined) ?? "deepseek-api";
  if (provider !== "deepseek-api") die(`--provider must be deepseek-api`);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) die(`API key required: set DEEPSEEK_API_KEY env`);

  const result = await computeDeepseekUsage({
    apiKey,
    currency: values.currency as string | undefined,
    dailyBudget: values.budget as string | undefined,
    weeklyBudget: values["weekly-budget"] as string | undefined,
    resetToday: values["reset-today"] === true || values.reset === true,
    configPath: (values.config as string | undefined) ?? defaultStatePath(),
  });

  return result.detail;
}

function render(s: DeepseekComputeResult["detail"]): string {
  const dailyColor = colorFor(s.todayUsedPercent);
  const weekColor = colorFor(s.weekUsedPercent);
  const budgetWidth = Math.max(
    s.todayLeft.toFixed(2).length,
    s.dailyBudget.toFixed(2).length,
    s.weekLeft.toFixed(2).length,
    s.weeklyBudget.toFixed(2).length,
  );
  const budgetMoney = (n: number) => alignedMoney(n, s.currency, budgetWidth);
  const lines = [
    fmtTime(),
    `  provider       ${cyan(s.provider)}`,
    `  account        ${money(s.accountBalance, s.currency)} total  (${money(s.grantedBalance, s.currency)} granted + ${money(s.toppedUpBalance, s.currency)} topped-up)`,
    `  weekly budget  ${budgetMoney(s.weekLeft)} left / ${budgetMoney(s.weeklyBudget)}  ${weekColor(bar(s.weekUsedPercent))} ${weekColor(pct(s.weekUsedPercent))} used`,
    `  daily budget   ${budgetMoney(s.todayLeft)} left / ${budgetMoney(s.dailyBudget)}  ${dailyColor(bar(s.todayUsedPercent))} ${dailyColor(pct(s.todayUsedPercent))} used`,
    `  today spent    ${money(s.todayUsed, s.currency)} since ${s.day}`,
    `  day baseline   ${money(s.baselineBalance, s.currency)}  ${dim(s.baselineCreatedAt)}`,
    `  week spent     ${money(s.weekUsed, s.currency)} since ${s.weekStart}`,
    `  week baseline  ${money(s.weekBaselineBalance, s.currency)}  ${dim(s.weekBaselineCreatedAt)}`,
    `  state          ${dim(s.statePath)}`,
    `  available      ${s.isAvailable ? green("yes") : red("no")}`,
  ];
  if (s.resetToday) lines.push(dim("  today's baseline reset to current account balance"));
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
        "weekly-budget": { type: "string" },
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
