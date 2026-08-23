import "./node-platform.js";
import process from "node:process";
import { persistBudgetCaps } from "./balance-ledger.js";
import { defaultStatePath } from "./provider/deepseek.js";
import { dim } from "./format.js";

export const DEEPSEEK_BUDGET_DEFAULTS = { daily: 7, weekly: 35, monthly: 70 } as const;

export const BUDGET_HELP = `ai-quota budget — persist API usage budget caps (no balance query)

Usage: ai-quota budget -p <provider> [options]

Examples:
  ai-quota budget -p deepseek-api -w 10 -m 70
  ai-quota budget -p deepseek-api --budget 10 -w 10 -m 70

Options:
  -p, --provider <name>   Provider (only deepseek-api supported)
  -w <AMOUNT>             Weekly budget cap
  -m <AMOUNT>             Monthly budget cap
      --budget <AMOUNT>   Daily budget cap (optional)
      --config <PATH>     State file (default: ~/.config/ai-quota/api-usage.json)
      --currency <CODE>   Ledger currency (default: CNY)
  -h, --help              Show this help
`;

export interface BudgetCapsArgs {
  provider?: string;
  weekly?: string;
  monthly?: string;
  daily?: string;
  config?: string;
  currency?: string;
  help?: boolean;
}

function budgetDie(msg: string): never {
  process.stderr.write(`ai-quota: ${msg}\n`);
  process.exit(2);
  throw new Error(msg);
}

export function parseBudgetArgs(argv: string[]): BudgetCapsArgs {
  const out: BudgetCapsArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-p" || a === "--provider") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires a provider name`);
      out.provider = v;
      continue;
    }
    if (a === "-w" || a === "--weekly-budget") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires an amount`);
      out.weekly = v;
      continue;
    }
    if (a === "-m" || a === "--monthly-budget") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires an amount`);
      out.monthly = v;
      continue;
    }
    if (a === "--budget") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires an amount`);
      out.daily = v;
      continue;
    }
    if (a === "--config") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires a path`);
      out.config = v;
      continue;
    }
    if (a === "--currency") {
      const v = argv[++i];
      if (!v) budgetDie(`${a} requires a code`);
      out.currency = v;
      continue;
    }
    budgetDie(`unknown budget argument: ${a}`);
  }
  return out;
}

/** `ai-quota budget -p deepseek-api -w … -m …` */
export function handleBudgetSubcommand(args: string[]): void {
  const caps = parseBudgetArgs(args);
  if (caps.help) {
    process.stdout.write(BUDGET_HELP);
    return;
  }

  const provider = caps.provider ?? "deepseek-api";
  if (provider !== "deepseek-api") {
    budgetDie(`budget: unsupported provider ${provider} (only deepseek-api)`);
  }
  if (!caps.help && caps.weekly === undefined && caps.monthly === undefined && caps.daily === undefined) {
    budgetDie("budget: set at least one of -w <weekly>, -m <monthly>, or --budget <daily>");
  }

  const path = caps.config ?? defaultStatePath();
  const state = persistBudgetCaps(
    path,
    { weekly: caps.weekly, monthly: caps.monthly, daily: caps.daily, currency: caps.currency },
    { ...DEEPSEEK_BUDGET_DEFAULTS },
  );
  const parts = [
    caps.weekly !== undefined ? `weekly ${state.weeklyBudget}` : "",
    caps.monthly !== undefined ? `monthly ${state.monthlyBudget}` : "",
    caps.daily !== undefined ? `daily ${state.dailyBudget}` : "",
  ].filter(Boolean);
  process.stdout.write(`ai-quota: ${provider} saved ${parts.join(", ")} ${state.currency} → ${dim(path)}\n`);
}