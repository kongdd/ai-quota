#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { QuotaError } from "./provider/minimax.js";
import { queryResetCredits, CodexAuthError, loadCodexToken, type CodexResetCredit, type CodexResetCredits } from "./provider/openai.js";
import { ClaudeAuthError } from "./provider/claude.js";
import { OpencodeAuthError } from "./provider/opencode.js";
import {
  aiQuotaConfigPath,
  getOpencodeGoLongPeriod,
  parseOpencodeGoLongPeriod,
  setOpencodeGoLongPeriod,
} from "./config.js";
import { DeepSeekUsageError } from "./provider/deepseek.js";
import { GrokAuthError } from "./provider/grok.js";
import { KimiAuthError } from "./provider/kimi.js";
import { ZhipuError } from "./provider/zhipu.js";
import { renderReport, dim, displayName } from "./format.js";
import {
  KNOWN_PROVIDERS,
  KNOWN_ITEMS,
  authConfigPath,
  isEnabled,
  loadAuthConfig,
  normalizeName,
  saveAuthConfig,
} from "./auth.js";
import { handleBudgetSubcommand } from "./budget-cmd.js";
import { runQuotaQuery, type Provider, type QueryResult, queryCodexResetSnapshot } from "./query.js";
import { runServeCommand } from "./server.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `ai-quota — coding-plan quota for MiniMax, OpenAI Codex, Claude Code, OpenCode Go, DeepSeek API, Grok Build, Kimi Coding Plan, and Zhipu GLM Coding Plan

Usage: ai-quota [options]

By default, queries all providers in parallel and prints one combined report.
Use --provider to limit to a subset (repeatable or comma-separated). Use --watch to refresh periodically in place.

Options:
  -p, --provider <NAME>[,<NAME>...]  One or more of: minimax, openai, claude, opencode, deepseek-api, grok, kimi, zhipu
                                 Also: -p openai claude  or  -p openai -p claude  (default: enabled ones; first run auto-detects from ~/.pi/agent/auth.json)
      --long [1w|1m]               OpenCode Go: omit value → 5h+1w+1m columns; 1w|1m → second column (else config)
  -r, --region <cn|intl>           MiniMax endpoint (default: cn)
      --codex-auth <PATH>          Codex auth.json path (default: \$CODEX_HOME/auth.json or ~/.codex/auth.json)
      --claude-auth <PATH>         Claude credentials path (default: \$CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json)
      --deepseek-config, --config <PATH> DeepSeek budget state file (default: ~/.config/ai-quota/api-usage.json)
      --reset-today, --reset       Reset DeepSeek daily + weekly baselines
  -w, --watch                      Refresh in place until Ctrl+C (implied by --interval)
  -i, --interval <SECS>            Watch refresh interval (accepts 30, 30s, 1m; default 60). Implies --watch.
      --compact, --wide            Force vertical (one column per line) or horizontal layout; default: auto by stdout width
      --reset-card                 Append codex reset cards under the codex line (implies --compact)
  -h, --help                       Show this help
  -v, --version                    Show version

Subcommands:
  ai-quota auth list                        Show enabled/disabled status of providers and plans
  ai-quota auth enable <NAME>               Enable a provider or plan
  ai-quota auth disable <NAME>              Disable a provider or plan
  ai-quota config long                      Show OpenCode Go second-column period (1w or 1m)
  ai-quota config long <1w|1m>              Set OpenCode Go week vs month quota display
  ai-quota budget -p deepseek-api -w 10 -m 70   Persist DeepSeek weekly/monthly caps (no API call)
  ai-quota query reset-card -p codex         Show Codex rate-limit reset cards
  ai-quota serve                             Start the local JSON API
`;

const AUTH_HELP = `ai-quota auth — manage which providers and plans are queried

Usage: ai-quota auth <command>

Commands:
  list                       Show enabled/disabled status of every known provider and plan
  enable <NAME>              Enable the named provider or plan
  disable <NAME>             Disable the named provider or plan

Known names: ${KNOWN_PROVIDERS.join(", ")}

Config file: ${authConfigPath()} (overridable via \$XDG_CONFIG_HOME)
`;

const CONFIG_HELP = `ai-quota config — OpenCode Go display preferences

Usage: ai-quota config long [1w|1m]

  long           Print current second-column period (default 1m)
  long 1w        Use weekly quota on opencode-go reports
  long 1m        Use monthly quota on opencode-go reports (default)

Config file: ${aiQuotaConfigPath()}
One-off: ai-quota -p opencode --long 1w | ai-quota -p opencode --long (three columns)
`;

const QUERY_HELP = `Usage: ai-quota query reset-card -p codex [--codex-auth <PATH>]
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
  if (e instanceof GrokAuthError) return e.message;
  if (e instanceof KimiAuthError) return e.message;
  if (e instanceof ZhipuError) return e.status ? `${e.status}: ${e.message}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 不可重试的"致命"错误：鉴权失败 / HTTP 4xx-5xx / 未知错误。watch 模式下立即退出。 */
function isFatal(e: unknown): boolean {
  if (e instanceof CodexAuthError) return !e.retryable;
  if (e instanceof ClaudeAuthError) return !e.retryable;
  if (e instanceof OpencodeAuthError) return !e.retryable;
  if (e instanceof GrokAuthError) return !e.retryable;
  if (e instanceof KimiAuthError) return !e.retryable;
  if (e instanceof QuotaError) return e.status !== undefined; // 有 HTTP status = 致命
  if (e instanceof ZhipuError) return e.status !== undefined;  // 鉴权/HTTP 错误一律视为致命
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

/** `ai-quota config long [1w|1m]` — 仅 OpenCode Go 第二列周/月额度。 */
function handleConfigSubcommand(args: string[]): void {
  const section = args[0];
  if (section !== "long") {
    if (section === undefined || section === "help" || section === "-h" || section === "--help") {
      process.stdout.write(CONFIG_HELP);
      return;
    }
    die(`unknown config section: ${section}. Use: long\n\n${CONFIG_HELP}`);
  }

  const periodArg = args[1];
  if (periodArg === undefined) {
    process.stdout.write(`${getOpencodeGoLongPeriod()}\n`);
    return;
  }

  try {
    const period = parseOpencodeGoLongPeriod(periodArg);
    setOpencodeGoLongPeriod(period);
    process.stdout.write(`ai-quota: OpenCode Go long window set to ${period}\n`);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

function localTime(iso?: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("sv-SE", { hour12: false });
}

function renderResetCredits(data: CodexResetCredits): string {
  const cards = availableResetCards(data.credits);
  const lines = [`codex reset cards: ${data.availableCount} available`];
  if (cards.length) lines.push("GRANTED (LOCAL)      EXPIRES (LOCAL)      TITLE");
  for (const card of cards) {
    lines.push(`${localTime(card.grantedAt).padEnd(20)} ${localTime(card.expiresAt).padEnd(20)} ${card.title ?? "-"}`);
  }
  return lines.join("\n");
}

/** 把 codex reset cards 格式化为多行字符串（每行一项），供 compact 布局嵌套在 provider 行下。 */
function formatCodexResetCards(credits: CodexResetCredit[], availableCount: number): string {
  const cards = availableResetCards(credits);
  const head = `reset: ${availableCount} available`;
  const rows = cards.map((c) => `${localTime(c.grantedAt)} → ${localTime(c.expiresAt)}  ${c.title ?? "-"}`);
  return [head, ...rows].join("\n");
}

/** 过滤 + 按过期时间升序：给两种渲染（独立命令 / compact 嵌套）共享。 */
function availableResetCards(credits: CodexResetCredit[]): CodexResetCredit[] {
  return credits
    .filter((c) => (c.status ?? "available") === "available")
    .sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""));
}

async function handleQuerySubcommand(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(QUERY_HELP);
    return;
  }
  if (args[0] !== "reset-card") die(QUERY_HELP.trim());

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: args.slice(1),
      options: {
        provider: { type: "string", short: "p" },
        "codex-auth": { type: "string" },
      },
    }) as { values: Record<string, unknown> });
  } catch (e) {
    die(`${e instanceof Error ? e.message : e}\n${QUERY_HELP}`);
  }
  if (values.provider !== "codex") die("query reset-card requires `-p codex`");

  try {
    const token = loadCodexToken(values["codex-auth"] as string | undefined);
    process.stdout.write(`${renderResetCredits(await queryResetCredits(token))}\n`);
  } catch (e) {
    die(formatError(e));
  }
}

/** 渲染单帧，并返回首个致命错误。 */
function renderFrame(results: QueryResult[], compact?: boolean, extras?: Record<string, string>): { body: string; fatal?: Extract<QueryResult, { ok: false }> } {
  const items = results.filter((r): r is Extract<QueryResult, { ok: true }> => r.ok).flatMap((r) => r.items);
  const errorLines = results
    .filter((r): r is Extract<QueryResult, { ok: false }> => !r.ok)
    .map((r) => `ai-quota: ${r.name}: ${formatError(r.error)}`);
  const report = items.length === 0 ? dim("no quota data") : renderReport(items, Date.now(), "MiniMax Coding Plan", compact, extras);
  const body = errorLines.length === 0 ? report : `${report}\n${errorLines.join("\n")}`;
  const fatal = results.find((r): r is Extract<QueryResult, { ok: false }> => !r.ok && isFatal(r.error));
  return { body, fatal };
}

function printOnce(results: QueryResult[], compact?: boolean, extras?: Record<string, string>): void {
  // 单 provider：没东西可显示，必须 die
  if (results.length === 1) {
    const r = results[0]!;
    if (!r.ok) die(formatError(r.error));
    process.stdout.write(renderReport(r.items, Date.now(), "MiniMax Coding Plan", compact, extras) + "\n");
    return;
  }
  // 多 provider：统一渲染；全部失败 → exit 2，否则正常打印
  const { body } = renderFrame(results, compact, extras);
  if (!results.some((r) => r.ok)) process.exit(2);
  process.stdout.write(body + "\n");
}

async function runWatch(
  providers: Provider[],
  values: Record<string, unknown>,
  intervalMs: number,
  compact?: boolean,
  fetchExtras?: () => Promise<Record<string, string> | undefined>,
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
    const results = await runQuotaQuery(providers, values);
    const extras = await fetchExtras?.();
    const { body, fatal } = renderFrame(results, compact, extras);
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
  if (argv[0] === "config") {
    handleConfigSubcommand(argv.slice(1));
    return;
  }
  if (argv[0] === "budget") {
    handleBudgetSubcommand(argv.slice(1));
    return;
  }
  if (argv[0] === "query") {
    await handleQuerySubcommand(argv.slice(1));
    return;
  }
  if (argv[0] === "serve") {
    try {
      await runServeCommand(argv.slice(1));
    } catch (e) {
      die(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  let opencodeLongAll = false;
  const parseArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // -p/--provider 支持空格分隔的多个 provider：贪心吞掉后续非 flag 参数，折叠成逗号分隔
    if (a === "-p" || a === "--provider") {
      const names: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        names.push(argv[++i]!);
      }
      if (names.length > 0) parseArgv.push(a, names.join(","));
      else parseArgv.push(a); // 无参数：留给 parseArgs 报 "requires argument"
      continue;
    }
    if (a === "--long") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        opencodeLongAll = true;
        continue;
      }
      parseArgv.push(a, next);
      i++;
      continue;
    }
    parseArgv.push(a);
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: parseArgv,
      options: {
        provider: { type: "string", short: "p", multiple: true },
        long: { type: "string" },
        region: { type: "string", short: "r", default: "cn" },
        "zhipu-region": { type: "string" },
        "zhipu-org": { type: "string" },
        "zhipu-project": { type: "string" },
        "codex-auth": { type: "string" },
        "claude-auth": { type: "string" },
        "deepseek-daily-budget": { type: "string" },
        "deepseek-weekly-budget": { type: "string" },
        "deepseek-monthly-budget": { type: "string" },
        "deepseek-config": { type: "string" },
        budget: { type: "string" },
        "weekly-budget": { type: "string" },
        "monthly-budget": { type: "string" },
        currency: { type: "string" },
        config: { type: "string" },
        "reset-today": { type: "boolean" },
        reset: { type: "boolean" },
        watch: { type: "boolean", short: "w" },
        interval: { type: "string", short: "i" },
        compact: { type: "boolean" },
        wide: { type: "boolean" },
        "reset-card": { type: "boolean" },
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

  if (opencodeLongAll) values["opencode-long-all"] = true;

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const authCfg = loadAuthConfig();

  // --provider 是一次性覆盖，跳过 auth 过滤；支持重复传参和逗号分隔（-p a,b / -p a -p b）
  const rawProviders = values.provider as string[] | undefined;
  let providers: Provider[];
  if (rawProviders !== undefined) {
    const picked = new Set<Provider>();
    for (const raw of rawProviders) {
      for (const piece of raw.split(",")) {
        const name = normalizeName(piece);
        if (!name || !(KNOWN_PROVIDERS as readonly string[]).includes(name)) {
          die(`--provider must be ${KNOWN_PROVIDERS.join(", ")}, or omitted (got: ${piece.trim()})`);
        }
        picked.add(name as Provider);
      }
    }
    if (picked.size === 0) die(`--provider must be ${KNOWN_PROVIDERS.join(", ")}, or omitted`);
    providers = [...picked];
  } else {
    providers = (KNOWN_PROVIDERS as readonly Provider[]).filter((p) => isEnabled(authCfg, p));
    if (providers.length === 0) {
      process.stdout.write("ai-quota: no providers enabled. Run `ai-quota auth list` to inspect.\n");
      return;
    }
  }

  // 布局优先级：--wide 强制 false > --compact/--reset-card 强制 true > 默认按 columns 启发。
  const wantResetCards = values["reset-card"] === true;
  const compact = compactFlag(values)
    ?? (wantResetCards || (process.stdout.columns ?? 80) < 60);
  const fetchCodexExtras = wantResetCards && (providers as string[]).includes("openai")
    ? async () => {
        try {
          const snap = await queryCodexResetSnapshot();
          if (snap.status !== "ok" || snap.credits.length === 0) return undefined;
          return { "codex": formatCodexResetCards(snap.credits, snap.availableCount) };
        } catch {
          return undefined;
        }
      }
    : undefined;

  // 传 --watch 或 --interval 都进入 watch 模式；未指定 interval 时走默认 60s
  if (values.watch || values.interval !== undefined) {
    const raw = (values.interval as string | undefined) ?? "60";
    const intervalMs = parseInterval(raw);
    await runWatch(providers, values, intervalMs, compact, fetchCodexExtras);
    return;
  }
  // 非 watch 模式：TTY 下启动清屏，避免连续两次跑时输出堆在旧结果后面
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  const extras = await fetchCodexExtras?.();
  printOnce(await runQuotaQuery(providers, values), compact, extras);
}

/** --compact 强制竖排；--wide 强制横排；都不传返回 undefined（交给 stdout.columns 启发）。 */
function compactFlag(values: Record<string, unknown>): boolean | undefined {
  if (values.compact === true) return true;
  if (values.wide === true) return false;
  return undefined;
}

void main();
