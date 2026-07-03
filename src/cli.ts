#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { queryQuota as queryMinimax, QuotaError, type ModelRemain, type Region } from "./minimax.js";
import { queryQuota as queryOpenai, CodexAuthError, loadCodexToken } from "./openai.js";
import { queryQuota as queryClaude, ClaudeAuthError, loadClaudeToken } from "./claude.js";
import { queryQuota as queryOpencode, OpencodeAuthError } from "./opencode.js";
import { computeDeepseekUsage, DeepSeekUsageError, defaultStatePath } from "./deepseek.js";
import { renderReport, dim, displayName } from "./format.js";
import {
  KNOWN_PROVIDERS,
  KNOWN_ITEMS,
  KNOWN_PLANS,
  authConfigPath,
  isEnabled,
  loadAuthConfig,
  normalizeName,
  saveAuthConfig,
} from "./auth.js";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

type Provider = "minimax" | "openai" | "claude" | "opencode" | "deepseek-api";
type Runner = (v: Record<string, unknown>) => Promise<ModelRemain[]>;

const HELP = `ai-quota — coding-plan quota for MiniMax, OpenAI Codex, Claude Code, OpenCode Go, and DeepSeek API

Usage: ai-quota [options]

By default, queries all providers in parallel and prints one combined report.
Use --provider to limit to a single one. Use --watch to refresh periodically in place.

Options:
  -p, --provider <minimax|openai|claude|opencode|deepseek-api>  Single provider (default: all enabled)
  -r, --region <cn|intl>           MiniMax endpoint (default: cn)
      --codex-auth <PATH>          Codex auth.json path (default: \$CODEX_HOME/auth.json or ~/.codex/auth.json)
      --claude-auth <PATH>         Claude credentials path (default: \$CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json)
      --deepseek-daily-budget <AMOUNT>  DeepSeek daily budget override (default: 7)
      --deepseek-weekly-budget <AMOUNT> DeepSeek weekly budget override (default: 35)
      --deepseek-config <PATH>     DeepSeek budget state file (default: ~/.config/ai-quota/api-usage.json)
  -w, --watch                      Refresh in place until Ctrl+C (implied by --interval)
  -i, --interval <SECS>            Watch refresh interval (accepts 30, 30s, 1m; default 60). Implies --watch.
  -h, --help                       Show this help
  -v, --version                    Show version

Subcommands:
  ai-quota auth list                        Show enabled/disabled status of providers and plans
  ai-quota auth enable <NAME>               Enable a provider or plan
  ai-quota auth disable <NAME>              Disable a provider or plan
`;

const AUTH_HELP = `ai-quota auth — manage which providers and plans are queried

Usage: ai-quota auth <command>

Commands:
  list                       Show enabled/disabled status of every known provider and plan
  enable <NAME>              Enable the named provider or plan
  disable <NAME>             Disable the named provider or plan

Known names: ${KNOWN_PROVIDERS.join(", ")}, ${KNOWN_PLANS.join(", ")}

Config file: ${authConfigPath()} (overridable via \$XDG_CONFIG_HOME)
`;

function die(msg: string): never {
  process.stderr.write(`ai-quota: ${msg}\n`);
  process.exit(2);
  throw new Error(msg);
}

function formatError(e: unknown): string {
  if (e instanceof QuotaError) return e.status ? `${e.status}: ${e.message}` : e.message;
  if (e instanceof CodexAuthError) return e.message;
  if (e instanceof ClaudeAuthError) return e.message;
  if (e instanceof OpencodeAuthError) return e.message;
  if (e instanceof DeepSeekUsageError) return e.status ? `${e.status}: ${e.message}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 不可重试的"致命"错误：鉴权失败 / HTTP 4xx-5xx / 未知错误。watch 模式下立即退出。 */
function isFatal(e: unknown): boolean {
  if (e instanceof CodexAuthError) return !e.retryable;
  if (e instanceof ClaudeAuthError) return !e.retryable;
  if (e instanceof OpencodeAuthError) return !e.retryable;
  if (e instanceof QuotaError) return e.status !== undefined; // 有 HTTP status = 致命
  return true;
}

/** 解析 "30" / "30s" / "1m" 形式的间隔字符串，返回毫秒。最小 1s。 */
function parseInterval(s: string): number {
  const m = /^(\d+)\s*(s|m)?$/.exec(s.trim());
  if (!m) die(`--interval must be a positive number (e.g. 30, 30s, 1m)`);
  const n = Number(m[1]);
  if (n < 1) die(`--interval must be >= 1s`);
  return n * (m[2] === "m" ? 60_000 : 1_000);
}

/** 把毫秒格式化为 "30s" / "2m" / "1m30s"，给 watch 头展示用。 */
function fmtInterval(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

/** 处理 `ai-quota auth <list|enable|disable>` 子命令。无返回（要么 die 要么写 stdout 后退出）。 */
function handleAuthSubcommand(args: string[]): void {
  const cmd = args[0];
  const cfg = loadAuthConfig();
  const path = authConfigPath();

  if (cmd === "list" || cmd === undefined) {
    const sorted = [...KNOWN_ITEMS].sort();
    const w = Math.max(5, ...sorted.map((n) => n.length));
    process.stdout.write(`${"NAME".padEnd(w)}  STATUS\n`);
    for (const name of sorted) {
      process.stdout.write(`${name.padEnd(w)}  ${isEnabled(cfg, name) ? "enabled" : "disabled"}\n`);
    }
    process.stdout.write(`\nconfig: ${path}\n`);
    return;
  }

  if (cmd === "enable" || cmd === "disable") {
    const arg = args[1];
    if (!arg) die(`auth ${cmd} requires a name. Known: ${KNOWN_ITEMS.join(", ")}`);
    const name = normalizeName(arg);
    if (!name) die(`unknown name: ${arg}. Known: ${KNOWN_ITEMS.join(", ")}`);
    const next = { ...cfg, [name]: cmd === "enable" };
    saveAuthConfig(next);
    process.stdout.write(`ai-quota: ${cmd}d ${name}\n`);
    return;
  }

  die(`unknown auth command: ${cmd}\n\n${AUTH_HELP}`);
}

async function runMinimax(values: Record<string, unknown>): Promise<ModelRemain[]> {
  const region = values.region as Region;
  if (region !== "cn" && region !== "intl") throw new Error(`--region must be cn or intl`);
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("API key required: set MINIMAX_API_KEY env");
  const data = await queryMinimax(key, region);
  return data.model_remains;
}

async function runOpenai(values: Record<string, unknown>): Promise<ModelRemain[]> {
  const authPath = values["codex-auth"] as string | undefined;
  const token = loadCodexToken(authPath);
  const data = await queryOpenai(token);
  return data.model_remains;
}

async function runClaude(values: Record<string, unknown>): Promise<ModelRemain[]> {
  const authPath = values["claude-auth"] as string | undefined;
  const token = loadClaudeToken(authPath);
  const data = await queryClaude(token);
  return data.model_remains;
}

async function runOpencode(_values: Record<string, unknown>): Promise<ModelRemain[]> {
  const data = await queryOpencode();
  return data.model_remains;
}

async function runDeepseek(values: Record<string, unknown>): Promise<ModelRemain[]> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("API key required: set DEEPSEEK_API_KEY env");
  const result = await computeDeepseekUsage({
    apiKey: key,
    currency: values.currency as string | undefined,
    dailyBudget: values["deepseek-daily-budget"] as string | undefined,
    weeklyBudget: values["deepseek-weekly-budget"] as string | undefined,
    resetToday: values["reset-today"] === true || values.reset === true,
    configPath: (values["deepseek-config"] as string | undefined) ?? defaultStatePath(),
  });
  return result.modelRemains;
}

type RunResult =
  | { name: Provider; ok: true; items: ModelRemain[] }
  | { name: Provider; ok: false; error: unknown };

async function runOnce(providers: Provider[], values: Record<string, unknown>, runners: Record<Provider, Runner>): Promise<RunResult[]> {
  const settled = await Promise.allSettled(providers.map((p) => runners[p](values)));
  return providers.map((name, i): RunResult => {
    const r = settled[i]!;
    return r.status === "fulfilled"
      ? { name, ok: true, items: r.value }
      : { name, ok: false, error: r.reason };
  });
}

/** 把 runOnce 的结果渲染成单帧文本（含报告 + 错误行），并标记首个致命错误。
 *  watch / non-watch 共用渲染，调用方只决定写入位置与退出代码。 */
function renderFrame(results: RunResult[], filter?: (displayName: string) => boolean): { body: string; fatal?: Extract<RunResult, { ok: false }> } {
  const items = results.filter((r): r is Extract<RunResult, { ok: true }> => r.ok).flatMap((r) => r.items);
  const errorLines = results
    .filter((r): r is Extract<RunResult, { ok: false }> => !r.ok)
    .map((r) => `ai-quota: ${r.name}: ${formatError(r.error)}`);
  const report = items.length === 0 ? dim("no quota data") : renderReport(items, Date.now(), "MiniMax Coding Plan", filter);
  const body = errorLines.length === 0 ? report : `${report}\n${errorLines.join("\n")}`;
  const fatal = results.find((r): r is Extract<RunResult, { ok: false }> => !r.ok && isFatal(r.error));
  return { body, fatal };
}

function printOnce(results: RunResult[], filter?: (displayName: string) => boolean): void {
  // 单 provider：没东西可显示，必须 die
  if (results.length === 1) {
    const r = results[0]!;
    if (!r.ok) die(formatError(r.error));
    process.stdout.write(renderReport(r.items, Date.now(), "MiniMax Coding Plan", filter) + "\n");
    return;
  }
  // 多 provider：统一渲染；全部失败 → exit 2，否则正常打印
  const { body } = renderFrame(results, filter);
  if (!results.some((r) => r.ok)) process.exit(2);
  process.stdout.write(body + "\n");
}

async function runWatch(
  providers: Provider[],
  values: Record<string, unknown>,
  runners: Record<Provider, Runner>,
  intervalMs: number,
  filter?: (displayName: string) => boolean,
): Promise<void> {
  const isTty = !!process.stdout.isTTY;
  let lastLines = 0;
  // 退避：retryable 错误时把下次间隔翻倍，连续失败最多到 5 分钟；下一次成功重置
  const maxBackoffMs = 5 * 60_000;
  let failures = 0;
  let currentIntervalMs = intervalMs;
  let timer: NodeJS.Timeout | undefined;

  const hint = (ms: number) =>
    dim(`watch · refresh every ${fmtInterval(ms)} · Ctrl+C to stop`);

  // TTY：光标倒带 + 清行，原位重画；非 TTY（pipe / redirect）：追加模式，历史可保留
  const writeFrame = (body: string) => {
    const out = body.endsWith("\n") ? body : body + "\n";
    if (isTty && lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`);
    process.stdout.write(out);
    lastLines = out.split("\n").length - 1;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, currentIntervalMs);
  };

  const tick = async () => {
    const results = await runOnce(providers, values, runners);
    const { body, fatal } = renderFrame(results, filter);
    if (fatal) {
      process.stderr.write(`ai-quota: ${fatal.name}: ${formatError(fatal.error)}\n`);
      process.exit(2);
    }
    const retryable = results.some((r) => !r.ok);

    if (retryable) {
      failures++;
      currentIntervalMs = Math.min(intervalMs * 2 ** failures, maxBackoffMs);
    } else {
      failures = 0;
      currentIntervalMs = intervalMs;
    }
    writeFrame(`${hint(currentIntervalMs)}\n${body}`);
    schedule();
  };

  process.on("SIGINT", () => {
    if (timer) clearTimeout(timer);
    process.stdout.write("\n");
    process.exit(0);
  });
  await tick();
}

async function main(): Promise<void> {
  // 子命令分流必须在 parseArgs 之前 —— `auth list/enable/disable` 用位置参数
  const argv = process.argv.slice(2);
  if (argv[0] === "auth") {
    handleAuthSubcommand(argv.slice(1));
    return;
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string", short: "p" },
        region: { type: "string", short: "r", default: "cn" },
        "codex-auth": { type: "string" },
        "claude-auth": { type: "string" },
        "deepseek-daily-budget": { type: "string" },
        "deepseek-weekly-budget": { type: "string" },
        "deepseek-config": { type: "string" },
        watch: { type: "boolean", short: "w" },
        interval: { type: "string", short: "i" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: false,
    }) as { values: Record<string, unknown> });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = e instanceof Error ? e.message : String(e);
    die(code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? msg : `${msg}\n\n${HELP}`);
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const authCfg = loadAuthConfig();

  // --provider 是一次性覆盖，跳过 auth 过滤；不传则只查已启用的 provider
  const rawProvider = values.provider as string | undefined;
  let providers: Provider[];
  if (rawProvider !== undefined) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(rawProvider)) {
      die(`--provider must be ${KNOWN_PROVIDERS.join(", ")}, or omitted`);
    }
    providers = [rawProvider as Provider];
  } else {
    providers = (KNOWN_PROVIDERS as readonly Provider[]).filter((p) => isEnabled(authCfg, p));
    if (providers.length === 0) {
      process.stdout.write("ai-quota: no providers enabled. Run `ai-quota auth list` to inspect.\n");
      return;
    }
  }

  const runners: Record<Provider, Runner> = {
    minimax: runMinimax,
    openai: runOpenai,
    claude: runClaude,
    opencode: runOpencode,
    "deepseek-api": runDeepseek,
  };

  // plan 维度过滤：auth 配置决定启用哪些；"video" 类 plan 硬过滤（不归 auth 管，永不显示）。
  const planFilter = (name: string) =>
    !name.toLowerCase().includes("video") && isEnabled(authCfg, name);

  // 传 --watch 或 --interval 都进入 watch 模式；未指定 interval 时走默认 60s
  if (values.watch || values.interval !== undefined) {
    const raw = (values.interval as string | undefined) ?? "60";
    const intervalMs = parseInterval(raw);
    await runWatch(providers, values, runners, intervalMs, planFilter);
    return;
  }
  // 非 watch 模式：TTY 下启动清屏，避免连续两次跑时输出堆在旧结果后面
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  printOnce(await runOnce(providers, values, runners), planFilter);
}

void main();
