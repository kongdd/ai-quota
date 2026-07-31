import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const request = `import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new EnvHttpProxyAgent());
await fetch("https://www.bing.com", {
  signal: AbortSignal.timeout(10_000),
})`;
const directEnv = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete directEnv[key];
}
directEnv.NO_PROXY = "";
directEnv.no_proxy = "";

function runNode(args, env) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

test("environment proxy is used by fetch", () => {
  const args = ["--input-type=module", "--eval", request];
  const direct = runNode(args, directEnv);
  assert.equal(direct.status, 0, direct.stderr);

  const proxied = runNode(args, {
    ...directEnv,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
  });
  assert.notEqual(proxied.status, 0);
  assert.match(proxied.stderr, /ECONNREFUSED/);
});
