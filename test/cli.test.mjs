import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const env = {
  ...process.env,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
};

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

test("CLI starts with proxy environment", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("CLI preserves exit status with proxy environment", () => {
  const result = runCli(["--definitely-unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});
