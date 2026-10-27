import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_QUERY_VALUES,
  proxyFrom,
  proxyLabel,
  requestLabel,
} from "../src/network.ts";
import { PROVIDERS } from "../src/types.ts";

test("direct connection needs no proxy environment", () => {
  assert.equal(proxyFrom({}), undefined);
});

test("proxy environment supports lowercase fallback and no_proxy", () => {
  assert.deepEqual(proxyFrom({ http_proxy: "http://127.0.0.1:7890" }), {
    all: "http://127.0.0.1:7890",
  });
  assert.deepEqual(proxyFrom({
    HTTP_PROXY: "http://fallback:8080",
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost,127.0.0.1",
  }), {
    all: { url: "http://proxy:8080", noProxy: "localhost,127.0.0.1" },
  });
});

test("log labels omit proxy credentials and request query", () => {
  assert.equal(proxyLabel({ all: "http://user:secret@127.0.0.1:7890" }), "http://127.0.0.1:7890");
  assert.equal(requestLabel("https://example.com/quota?token=secret", "post"), "POST https://example.com/quota");
});

test("desktop follows CLI provider order", () => {
  assert.deepEqual(PROVIDERS, [
    "claude",
    "openai",
    "grok",
    "opencode",
    "minimax",
    "kimi",
    "zhipu",
    "deepseek-api",
  ]);
});

test("desktop bounds each provider query without retries", () => {
  assert.deepEqual(DESKTOP_QUERY_VALUES, { "timeout-ms": 10_000, retries: 1 });
});
