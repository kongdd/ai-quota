import assert from "node:assert/strict";
import { test } from "node:test";
import { queryBrowserQuota } from "../dist/browser.js";
import { renderReport } from "../dist/format.js";

const credential = { type: "oauth", refresh: "github-token", access: "expired-copilot-token", expires: 1 };
const usage = {
  quota_reset_date: "2030-11-01",
  quota_snapshots: {
    premium_interactions: { percent_remaining: 96.3, unlimited: false, entitlement: 1500, credits_used: 54 },
    chat: { percent_remaining: 100, unlimited: true },
    completions: { percent_remaining: 100, unlimited: true },
  },
};

function query(options = {}) {
  return queryBrowserQuota({
    env: { PI_CODING_AGENT_DIR: "/pi" },
    files: { "/pi/auth.json": JSON.stringify({ "github-copilot": credential }) },
    fetch: async () => Response.json(usage),
    ...options,
  });
}

const provider = (result) => result.snapshot.providers[0];

test("Copilot auto-enables from Pi and uses GitHub refresh, never Copilot access", async () => {
  let calls = 0;
  const result = await query({
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.github.com/copilot_internal/user");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "token github-token");
      assert.equal(init.headers.Accept, "application/json");
      assert.ok(init.headers["Editor-Version"]);
      assert.ok(init.headers["Editor-Plugin-Version"]);
      return Response.json(usage);
    },
  });
  const copilot = provider(result);
  assert.equal(calls, 1);
  assert.equal(copilot.provider, "github-copilot");
  assert.equal(copilot.status, "ok");
  const [model] = copilot.models;
  assert.equal(model.name, "github-copilot");
  assert.deepEqual(Object.keys(model.windows), ["monthly"]);
  assert.equal(model.windows.monthly.remainingPercent, 96.3);
  assert.ok(Math.abs(model.windows.monthly.usedPercent - 3.7) < 1e-10);
  assert.equal(model.windows.monthly.resetsAt, "2030-11-01T00:00:00.000Z");
  assert.equal(model.windows.monthly.status, "available");
  assert.deepEqual(result.writes, {});
});

test("Copilot honors explicit disablement without fetching", async () => {
  const result = await query({
    env: { PI_CONFIG_DIR: "/pi", XDG_CONFIG_HOME: "/config" },
    files: {
      "/pi/auth.json": JSON.stringify({ "github-copilot": credential }),
      "/config/ai-quota/auth.json": JSON.stringify({ "github-copilot": false }),
    },
    fetch: async () => { assert.fail("disabled provider must not fetch"); },
  });
  assert.deepEqual(result.snapshot.providers, []);
});

test("Copilot uses Pi Enterprise domain and precise UTC reset", async () => {
  const result = await query({
    files: { "/pi/auth.json": JSON.stringify({
      "github-copilot": { ...credential, enterpriseUrl: "https://company.ghe.com" },
    }) },
    fetch: async (url) => {
      assert.equal(String(url), "https://api.company.ghe.com/copilot_internal/user");
      return Response.json({ ...usage, quota_reset_date_utc: "2030-11-01T07:00:00Z" });
    },
  });
  assert.equal(provider(result).models[0].windows.monthly.resetsAt, "2030-11-01T07:00:00.000Z");
});

for (const auth of [undefined, { type: "api_key", key: "api-key" }, { type: "oauth", access: "copilot-only" }]) {
  test(`Copilot rejects missing GitHub OAuth token: ${JSON.stringify(auth)}`, async () => {
    const result = await query({
      providers: ["github-copilot"],
      files: { "/pi/auth.json": JSON.stringify({ "github-copilot": auth }) },
      fetch: async () => { assert.fail("invalid credentials must not fetch"); },
    });
    assert.equal(provider(result).error.code, "auth");
    assert.equal(provider(result).error.retryable, false);
    assert.deepEqual(result.writes, {});
  });
}

for (const [status, code, retryable] of [[401, "auth", false], [403, "auth", false], [429, "upstream", true], [500, "upstream", true]]) {
  test(`Copilot reports HTTP ${status}`, async () => {
    const result = await query({ fetch: async () => new Response(null, { status }) });
    assert.equal(provider(result).status, "error");
    assert.equal(provider(result).error.code, code);
    assert.equal(provider(result).error.httpStatus, status);
    assert.equal(provider(result).error.retryable, retryable);
    assert.deepEqual(result.writes, {});
  });
}

for (const payload of [
  null,
  {},
  { ...usage, quota_reset_date: "invalid" },
  { ...usage, quota_snapshots: { premium_interactions: { unlimited: true, percent_remaining: 100 } } },
  { ...usage, quota_snapshots: { premium_interactions: { has_quota: false, percent_remaining: 100 } } },
  { ...usage, quota_snapshots: { premium_interactions: { percent_remaining: "96.3" } } },
]) {
  test(`Copilot does not fabricate quotas: ${JSON.stringify(payload)}`, async () => {
    const result = await query({ fetch: async () => Response.json(payload) });
    assert.equal(provider(result).status, "error");
    assert.equal(provider(result).error.retryable, false);
  });
}

for (const [remaining, expected] of [[0, 0], [-5, 0], [105, 100]]) {
  test(`Copilot clamps ${remaining}% and preserves exhaustion`, async () => {
    const result = await query({ fetch: async () => Response.json({
      ...usage,
      quota_snapshots: { premium_interactions: { percent_remaining: remaining } },
    }) });
    const window = provider(result).models[0].windows.monthly;
    assert.equal(window.remainingPercent, expected);
    assert.equal(window.status, expected === 0 ? "exhausted" : "available");
  });
}

test("Copilot timeout and network failures are retryable", async () => {
  const network = await query({ fetch: async () => { throw new Error("offline"); } });
  assert.equal(provider(network).error.code, "network");
  assert.equal(provider(network).error.retryable, true);

  const timeout = await query({
    values: { "timeout-ms": 5 },
    fetch: async (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(provider(timeout).error.code, "timeout");
  assert.equal(provider(timeout).error.retryable, true);
});

test("Copilot malformed JSON is not reported as a network failure", async () => {
  const result = await query({ fetch: async () => new Response("invalid JSON") });
  assert.equal(provider(result).status, "error");
  assert.equal(provider(result).error.retryable, false);
});

test("Copilot displays gh-copilot in both layouts and labels monthly quota", () => {
  const items = [{
    model_name: "github-copilot",
    interval: { remaining_percent: 96.3, end_time: Date.parse("2030-11-01"), remains_time: 1, status: 1 },
  }];
  for (const compact of [false, true]) {
    const report = renderReport(items, 0, undefined, compact);
    assert.match(report, /\bgh-copilot\b/);
    assert.doesNotMatch(report, /github-copilot/);
    if (compact) {
      assert.match(report, /\bmo\b/);
      assert.doesNotMatch(report, /\b5h\b|\bwk\b/);
    }
  }
});
