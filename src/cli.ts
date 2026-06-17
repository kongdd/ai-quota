#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { queryQuota as queryMinimax, QuotaError, type Region } from "./minimax.js";
import { queryQuota as queryOpenai, CodexAuthError, loadCodexToken } from "./openai.js";
import { queryQuota as queryClaude, ClaudeAuthError, loadClaudeToken } from "./claude.js";
import { renderReport } from "./format.js";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

type Provider = "minimax" | "openai" | "claude";

const HELP = `ai-quota — coding-plan quota for MiniMax, OpenAI Codex, and Claude Code

Usage: ai-quota [options]

By default, queries all three providers in parallel and prints each result.
Use --provider to limit to a single one.

Options:
  -p, --provider <minimax|openai|claude>  Single provider (default: all three)
  -k, --key <KEY>                  MiniMax API key (or env MINIMAX_API_KEY)
  -r, --region <cn|intl>           MiniMax endpoint (default: cn)
  -g, --group-id <ID>              MiniMax group ID (optional)
      --codex-auth <PATH>          Codex auth.json path (default: \$CODEX_HOME/auth.json or ~/.codex/auth.json)
      --claude-auth <PATH>         Claude credentials path (default: \$CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json)
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

async function runMinimax(values: Record<string, unknown>): Promise<string> {
  const region = values.region as Region;
  if (region !== "cn" && region !== "intl") throw new Error(`--region must be cn or intl`);
  const key = (values.key as string | undefined) ?? process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("API key required: pass --key or set MINIMAX_API_KEY");
  const data = await queryMinimax(key, region, values["group-id"] as string | undefined);
  return renderReport(data.model_remains, Date.now(), "MiniMax Coding Plan");
}

async function runOpenai(values: Record<string, unknown>): Promise<string> {
  const authPath = values["codex-auth"] as string | undefined;
  const token = loadCodexToken(authPath);
  const data = await queryOpenai(token);
  return renderReport(data.model_remains, Date.now(), "OpenAI Codex");
}

async function runClaude(values: Record<string, unknown>): Promise<string> {
  const authPath = values["claude-auth"] as string | undefined;
  const token = loadClaudeToken(authPath);
  const data = await queryClaude(token);
  return renderReport(data.model_remains, Date.now(), "Claude Code");
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

  // 校验 --provider
  const rawProvider = values.provider as string | undefined;
  let providers: Provider[];
  if (rawProvider === undefined) {
    providers = ["minimax", "openai", "claude"];
  } else if (rawProvider === "minimax" || rawProvider === "openai" || rawProvider === "claude") {
    providers = [rawProvider];
  } else {
    die(`--provider must be minimax, openai, claude, or omitted`);
  }

  // 并行跑选中的 provider
  const runners: Record<Provider, (v: Record<string, unknown>) => Promise<string>> = {
    minimax: runMinimax,
    openai: runOpenai,
    claude: runClaude,
  };
  const settled = await Promise.allSettled(providers.map((p) => runners[p](values)));

  const blocks: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < providers.length; i++) {
    const r = settled[i]!;
    const name = providers[i];
    if (r.status === "fulfilled") {
      blocks.push(r.value);
    } else {
      failures.push(`${name}: ${formatError(r.reason)}`);
    }
  }

  // 单 provider 模式（任一失败即报错）；多 provider 模式（失败的写 stderr，成功仍打印）
  if (providers.length === 1) {
    if (failures.length) die(failures[0]!);
    process.stdout.write((blocks[0] ?? "") + "\n");
    return;
  }

  // 多 provider 模式
  for (const f of failures) process.stderr.write(`ai-quota: ${f}\n`);
  if (blocks.length === 0) process.exit(2);
  process.stdout.write(blocks.join("\n\n") + "\n");
}

void main();