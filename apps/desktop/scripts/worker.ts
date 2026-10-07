import { readFileSync } from "node:fs";
import { EnvHttpProxyAgent, fetch as httpFetch } from "undici";
import { queryBrowserQuota, type BrowserQueryOptions } from "../../../src/browser";
import { targetsOf } from "../src/display";
import { DESKTOP_QUERY_VALUES, requestLabel } from "../src/network";
import { mergeProvider, type ProviderSnapshot } from "../src/types";

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

try {
  const { runtime, providers, previous = [] } = JSON.parse(readFileSync(0, "utf8")) as {
    runtime: Omit<BrowserQueryOptions, "fetch">;
    providers?: BrowserQueryOptions["providers"];
    previous?: ProviderSnapshot[];
  };
  const env = runtime.env ?? {};
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy,
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy,
    noProxy: env.NO_PROXY ?? env.no_proxy,
  });
  log(`=== query start providers=${providers?.join(",") ?? "enabled"} ===`);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const label = requestLabel(input, init?.method);
    const started = Date.now();
    log(`request start ${label}`);
    try {
      const response = await httpFetch(input as string, {
        ...init as Parameters<typeof httpFetch>[1],
        dispatcher,
      });
      log(`request done ${label} status=${response.status} elapsed=${Date.now() - started}ms`);
      return response as unknown as Response;
    } catch (cause) {
      log(`request failed ${label}: ${cause instanceof Error ? cause.message : cause}`);
      throw cause;
    }
  };
  const result = await queryBrowserQuota({ ...runtime, providers, fetch, values: DESKTOP_QUERY_VALUES });
  if (!result.snapshot.providers.length) throw new Error("未找到可用凭据");
  if (providers) result.snapshot.providers = result.snapshot.providers.reduce(mergeProvider, previous);
  const succeeded = result.snapshot.providers.filter((item) => item.status === "ok").length;
  result.snapshot.status = succeeded === 0 ? "error"
    : succeeded === result.snapshot.providers.length ? "ok" : "partial";
  log(`query done status=${result.snapshot.status}`);
  console.log(JSON.stringify({ ...result, targets: targetsOf(result.snapshot.providers) }));
} catch (cause) {
  log(`query failed: ${cause instanceof Error ? cause.message : cause}`);
  process.exitCode = 1;
}
