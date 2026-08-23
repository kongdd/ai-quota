import {
  enabledProviders,
  queryQuotaSnapshot,
  type Provider,
  type QueryValues,
  type QuotaSnapshot,
} from "./query.js";
import { configurePlatform, memoryPlatform } from "./platform.js";

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

let queue = Promise.resolve();

/** Browser/Tauri adapter: inject HTTP and a virtual synchronous filesystem, then return changed files. */
export function queryBrowserQuota(options: BrowserQueryOptions): Promise<BrowserQueryResult> {
  const run = queue.then(async () => {
    const memory = memoryPlatform(options);
    const previous = configurePlatform(memory.runtime);
    try {
      const providers = options.providers ?? enabledProviders();
      const snapshot = await queryQuotaSnapshot({ providers, values: options.values, now: options.now });
      return { snapshot, writes: memory.writes() };
    } finally {
      configurePlatform(previous);
    }
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
