#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { queryQuota as queryMinimax, QuotaError, type ModelRemain, type Region } from "./minimax.js";
import { queryQuota as queryOpenai, CodexAuthError, loadCodexToken } from "./openai.js";
import { queryQuota as queryClaude, ClaudeAuthError, loadClaudeToken } from "./claude.js";
import { renderReport, dim } from "./format.js";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

type Provider = "minimax" | "openai" | "claude";
type Runner = (v: Record<string, unknown>) => Promise<ModelRemain[]>;

const HELP = `ai-quota — coding-plan quota for MiniMax, OpenAI Codex, and Claude Code

Usage: ai-quota [options]

By default, queries all three providers in parallel and prints one combined report.
Use --provider to limit to a single one. Use --watch to refresh periodically in place.

Options:
  -p, --provider <minimax|openai|claude>  Single provider (default: all three)
  -k, --key <KEY>                  MiniMax API key (or env MINIMAX_API_KEY)
  -r, --region <cn|intl>           MiniMax endpoint (default: cn)
  -g, --group-id <ID>              MiniMax group ID (optional)
      --codex-auth <PATH>          Codex auth.json path (default: \$CODEX_HOME/auth.json or ~/.codex/auth.json)
      --claude-auth <PATH>         Claude credentials path (default: \$CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json)
  -w, --watch                      Refresh in place until Ctrl+C (implied by --interval)
  -i, --interval <SECS>            Watch refresh interval (accepts 30, 30s, 1m; default 60). Implies --watch.
  -h, --help                       Show this help
  -v, --version                    Show version
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
  return e instanceof Error ? e.message : String(e);
}

/** 不可重试的"致命"错误：鉴权失败 / HTTP 4xx-5xx / 未知错误。watch 模式下立即退出。 */
function isFatal(e: unknown): boolean {
  if (e instanceof CodexAuthError) return !e.retryable;
  if (e instanceof ClaudeAuthError) return !e.retryable;
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

async function runMinimax(values: Record<string, unknown>): Promise<ModelRemain[]> {
  const region = values.region as Region;
  if (region !== "cn" && region !== "intl") throw new Error(`--region must be cn or intl`);
  const key = (values.key as string | undefined) ?? process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("API key required: pass --key or set MINIMAX_API_KEY");
  const data = await queryMinimax(key, region, values["group-id"] as string | undefined);
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

function printOnce(results: RunResult[]): void {
  const items = results.filter((r): r is Extract<RunResult, { ok: true }> => r.ok).flatMap((r) => r.items);
  const failures = results.filter((r): r is Extract<RunResult, { ok: false }> => !r.ok);

  if (results.length === 1) {
    const r = results[0]!;
    if (!r.ok) die(formatError(r.error));
    process.stdout.write(renderReport(r.items) + "\n");
    return;
  }
  for (const f of failures) process.stderr.write(`ai-quota: ${f.name}: ${formatError(f.error)}\n`);
  if (items.length === 0) process.exit(2);
  process.stdout.write(renderReport(items) + "\n");
}

async function runWatch(
  providers: Provider[],
  values: Record<string, unknown>,
  runners: Record<Provider, Runner>,
  intervalMs: number,
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
    const fatal = results.find((r): r is Extract<RunResult, { ok: false }> => !r.ok && isFatal(r.error));
    if (fatal) {
      process.stderr.write(`ai-quota: ${fatal.name}: ${formatError(fatal.error)}\n`);
      process.exit(2);
    }
    const retryable = results.some((r) => !r.ok);
    // 错误行放进 frame body 而非 stderr：stderr 行不会计入 lastLines，光标倒带够不到，
    // 上一帧的 hint + 本帧的 stderr 会一直留在屏幕上，hint 就越积越多。
    const errorLines = results
      .filter((r): r is Extract<RunResult, { ok: false }> => !r.ok)
      .map((r) => `ai-quota: ${r.name}: ${formatError(r.error)}`);
    const items = results.filter((r): r is Extract<RunResult, { ok: true }> => r.ok).flatMap((r) => r.items);
    const report = items.length === 0 ? dim("no quota data") : renderReport(items);
    const body = errorLines.length === 0 ? report : `${report}\n${errorLines.join("\n")}`;

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
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        provider: { type: "string", short: "p" },
        key: { type: "string", short: "k" },
        region: { type: "string", short: "r", default: "cn" },
        "group-id": { type: "string", short: "g" },
        "codex-auth": { type: "string" },
        "claude-auth": { type: "string" },
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

  const rawProvider = values.provider as string | undefined;
  let providers: Provider[];
  if (rawProvider === undefined) {
    providers = ["minimax", "openai", "claude"];
  } else if (rawProvider === "minimax" || rawProvider === "openai" || rawProvider === "claude") {
    providers = [rawProvider];
  } else {
    die(`--provider must be minimax, openai, claude, or omitted`);
  }

  const runners: Record<Provider, Runner> = {
    minimax: runMinimax,
    openai: runOpenai,
    claude: runClaude,
  };

  // 传 --watch 或 --interval 都进入 watch 模式；未指定 interval 时走默认 60s
  if (values.watch || values.interval !== undefined) {
    const raw = (values.interval as string | undefined) ?? "60";
    const intervalMs = parseInterval(raw);
    await runWatch(providers, values, runners, intervalMs);
    return;
  }
  // 非 watch 模式：TTY 下启动清屏，避免连续两次跑时输出堆在旧结果后面
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  printOnce(await runOnce(providers, values, runners));
}

void main();
