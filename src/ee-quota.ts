#!/usr/bin/env node
import process from "node:process";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { handleEeQuotaSubcommand } from "./ee-quota-cmd.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

try {
  await handleEeQuotaSubcommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ee-quota: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
