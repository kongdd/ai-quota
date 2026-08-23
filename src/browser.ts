import { loadAuthConfig, loadPiAuthKey } from "./core-auth.js";
import { queryQuotaSnapshot, type Provider, type QueryValues, type QuotaSnapshot } from "./core-query.js";
import { loadClaudeToken } from "./provider/claude.js";
import { loadGrokSubscriptionConfig } from "./provider/grok.js";
import { resolveKimiApiKey } from "./provider/kimi.js";
import { resolveMinimaxApiKey } from "./provider/minimax.js";
import { loadCodexToken } from "./provider/openai.js";
import { loadOpencodeGoConfig } from "./provider/opencode.js";
import { resolveZhipuApiKey } from "./provider/zhipu.js";
import { configurePlatform, env, memoryPlatform } from "./platform.js";

export interface BrowserQueryOptions {
  providers?: Provider[];
  fetch: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  home?: string;
  platform?: string;
  now?: number;
  values?: QueryValues;
}

export interface BrowserQueryResult {
  snapshot: QuotaSnapshot;
  writes: Record<string, string>;
}

const available = (query: () => unknown): boolean => {
  try {
    return Boolean(query());
  } catch {
    return false;
  }
};

function detectedProviders(): Provider[] {
  const config = loadAuthConfig();
  const checks: Record<Provider, () => unknown> = {
    minimax: () => resolveMinimaxApiKey("cn"),
    openai: loadCodexToken,
    claude: loadClaudeToken,
    opencode: loadOpencodeGoConfig,
    "deepseek-api": () => loadPiAuthKey("deepseek") ?? loadPiAuthKey("deepseek-api") ?? env.DEEPSEEK_API_KEY,
    grok: loadGrokSubscriptionConfig,
    kimi: resolveKimiApiKey,
    zhipu: resolveZhipuApiKey,
  };
  return (Object.keys(checks) as Provider[]).filter((provider) =>
    config[provider] === true || (config[provider] !== false && available(checks[provider])),
  );
}

let queue = Promise.resolve();

/** Browser/Tauri adapter: inject HTTP and a virtual synchronous filesystem, then return changed files. */
export function queryBrowserQuota(options: BrowserQueryOptions): Promise<BrowserQueryResult> {
  const run = queue.then(async () => {
    const memory = memoryPlatform(options);
    const previous = configurePlatform(memory.runtime);
    try {
      const providers = options.providers ?? detectedProviders();
      const snapshot = await queryQuotaSnapshot({ providers, values: options.values, now: options.now });
      return { snapshot, writes: memory.writes() };
    } finally {
      configurePlatform(previous);
    }
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
