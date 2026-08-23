import { invoke } from "@tauri-apps/api/core";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { queryBrowserQuota } from "../../../src/browser";
import {
  DESKTOP_QUERY_VALUES,
  proxyFrom,
  proxyLabel,
  requestLabel,
} from "./network";
import type { Provider, QuotaSnapshot } from "./types";

interface RuntimeSnapshot {
  home: string;
  platform: string;
  env: Record<string, string>;
  files: Record<string, string>;
}

const QUERY_TIMEOUT_MS = 35_000;
let queue = Promise.resolve();

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const appendLog = async (message: string) => {
  try {
    await invoke("append_log", { message: `${new Date().toISOString()} ${message}` });
  } catch (error) {
    console.error("write log.txt failed", error);
  }
};

export function queryQuota(providers?: Provider[]): Promise<QuotaSnapshot> {
  const run = queue.then(async () => {
    await appendLog(`=== query start providers=${providers?.join(",") ?? "enabled"} ===`);
    try {
      const runtime = JSON.parse(await invoke<string>("read_runtime")) as RuntimeSnapshot;
      const controller = new AbortController();
      const proxy = proxyFrom(runtime.env);
      await appendLog(`runtime platform=${runtime.platform} files=${Object.keys(runtime.files).join(",") || "none"} proxy=${proxyLabel(proxy)}`);

      const fetch: typeof globalThis.fetch = async (input, init) => {
        const label = requestLabel(input, init?.method);
        const started = performance.now();
        await appendLog(`request start ${label}`);
        try {
          const response = await httpFetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
            connectTimeout: 10_000,
            ...(proxy ? { proxy } : {}),
          });
          await appendLog(`request done ${label} status=${response.status} elapsed=${Math.round(performance.now() - started)}ms`);
          return response;
        } catch (error) {
          await appendLog(`request failed ${label} elapsed=${Math.round(performance.now() - started)}ms error=${errorMessage(error)}`);
          throw error;
        }
      };

      const query = queryBrowserQuota({
        ...runtime,
        providers,
        fetch,
        values: DESKTOP_QUERY_VALUES,
      });
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("查询超时（35 秒）"));
        }, QUERY_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([query, timeout]);
        if (!result.snapshot.providers.length) throw new Error("未找到可用凭据");
        const summary = result.snapshot.providers.map((provider) => provider.status === "ok"
          ? `${provider.provider}=ok`
          : `${provider.provider}=error(${provider.error.code}: ${provider.error.message})`).join("; ");
        await appendLog(`query done status=${result.snapshot.status} providers=${summary}`);
        if (Object.keys(result.writes).length) {
          await invoke("write_runtime", { writes: JSON.stringify(result.writes) });
          await appendLog(`state written files=${Object.keys(result.writes).join(",")}`);
        }
        return result.snapshot;
      } finally {
        clearTimeout(timer!);
      }
    } catch (error) {
      await appendLog(`query failed error=${errorMessage(error)}`);
      throw error;
    }
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
