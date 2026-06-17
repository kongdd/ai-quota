#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { queryQuota, QuotaError, type Region } from "./api.js";
import { renderReport } from "./format.js";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `minimax-quota — MiniMax Coding Plan 5h / weekly quota

Usage: minimax-quota [options]

Options:
  -k, --key <KEY>      API key (or env MINIMAX_API_KEY)
  -r, --region <cn|intl>  Endpoint (default: cn)
  -g, --group-id <ID>  Group ID (optional)
  -h, --help           Show this help
  -v, --version        Show version
`;

function die(msg: string): never {
  process.stderr.write(`minimax-quota: ${msg}\n`);
  process.exit(2);
  throw new Error(msg);
}

async function main(): Promise<void> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        key: { type: "string", short: "k" },
        region: { type: "string", short: "r", default: "cn" },
        "group-id": { type: "string", short: "g" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: false,
    }));
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

  const region = values.region as Region;
  if (region !== "cn" && region !== "intl") die(`--region must be cn or intl`);

  const key = (values.key as string | undefined) ?? process.env.MINIMAX_API_KEY;
  if (!key) die("API key required: pass --key or set MINIMAX_API_KEY");

  try {
    const data = await queryQuota(key, region, values["group-id"] as string | undefined);
    process.stdout.write(renderReport(data.model_remains) + "\n");
  } catch (e) {
    if (e instanceof QuotaError) die(e.status ? `${e.status}: ${e.message}` : e.message);
    die(e instanceof Error ? e.message : String(e));
  }
}

void main();
