import assert from "node:assert/strict";
import { test } from "node:test";
import { configurePlatform, memoryPlatform } from "../dist/platform.js";
import { queryQuota } from "../dist/provider/openai.js";
import { quotaSnapshot } from "../dist/query.js";
import { renderReport } from "../dist/format.js";

const claims = {
  iss: "https://auth.openai.com",
  aud: "https://api.openai.com/v1",
  scope: "openid chatgpt.tokens.use.direct",
  client_id: "oaiapp_current",
};
const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const short = { used_percent: 10, limit_window_seconds: 18_000, reset_at: 2_000_000_000 };
const weekly = { used_percent: 2, limit_window_seconds: 604_800, reset_at: 2_000_600_000 };
const app = { id: claims.client_id, allowed_usage_percent: 25, windows: [weekly, short] };
const plan = {
  plan_type: "plus",
  rate_limit: { primary_window: { ...short, used_percent: 40 } },
  chatpass: { windows: [{ ...short, used_percent: 80 }] },
};

test("OpenAI apps use Codex auth and match the exact Pi client, never the first app or shared pool", async () => {
  for (const scenario of [
    { payload: { items: [{ ...app, id: "oaiapp_other" }, app] } },
    { payload: { items: [{ ...app, windows: [weekly] }] }, weeklyOnly: true },
    { payload: { items: [{ ...app, windows: [weekly, { ...short, remaining_percent: 85 }] }] }, shortLeft: 85 },
    { payload: { items: [{ ...app, id: "oaiapp_other" }] }, error: /same ChatGPT account/ },
    { payload: { items: [app, app] }, error: /not uniquely found/ },
    { payload: null, error: /not uniquely found/ },
    { payload: { items: [{ ...app, windows: [] }] }, error: /no supported quota windows/ },
    { payload: { items: [{ ...app, windows: [{ ...short, reset_at: "invalid" }] }] }, error: /no supported quota windows/ },
    { status: 401, error: /apps usage HTTP 401/ },
  ]) {
    const calls = [];
    const memory = memoryPlatform({
      env: { PI_CODING_AGENT_DIR: "/pi" },
      files: { "/pi/auth.json": JSON.stringify({ openai: { type: "oauth", access: jwt(claims) } }) },
      fetch: async (input, init) => {
        calls.push(String(input));
        assert.equal(init.headers.Authorization, "Bearer codex-token");
        assert.equal(init.headers["chatgpt-account-id"], "account");
        if (String(input).endsWith("/chatpass/apps")) {
          assert.equal(init.redirect, "error");
          return Response.json(scenario.payload ?? null, { status: scenario.status ?? 200 });
        }
        return Response.json(plan);
      },
    });
    const previous = configurePlatform(memory.runtime);
    try {
      const pending = queryQuota({ accessToken: "codex-token", accountId: "account" }, { retries: 1 });
      if (scenario.error) {
        await assert.rejects(pending, scenario.error);
      } else {
        const result = await pending;
        const [codex, apps] = result.model_remains;
        assert.equal(codex.interval.remaining_percent, 60);
        assert.equal(apps.model_name, "openai · apps");
        assert.equal(apps.interval?.remaining_percent, scenario.weeklyOnly ? undefined : scenario.shortLeft ?? 90);
        assert.equal(apps.weekly.remaining_percent, 98);
        const snapshot = quotaSnapshot([{ name: "openai", ok: true, items: result.model_remains }]);
        assert.equal(snapshot.providers[0].models[1].windows.weekly.remainingPercent, 98);
        for (const compact of [true, false]) {
          const report = renderReport(result.model_remains, Date.now(), "", compact);
          assert.match(report, /openai·apps/);
          assert.doesNotMatch(report, /NaN|undefined/);
        }
      }
      assert.deepEqual(calls, [
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/wham/usage/chatpass/apps",
      ]);
      assert.deepEqual(memory.writes(), {});
    } finally {
      configurePlatform(previous);
    }
  }
});

test("Non-SIWC credentials do not trigger the app endpoint", async () => {
  for (const payload of [
    { ...claims, iss: "https://other.example" },
    { ...claims, aud: "other" },
    { ...claims, scope: "openid" },
    { ...claims, client_id: "invalid" },
    null,
  ]) {
    let calls = 0;
    const memory = memoryPlatform({
      env: { PI_CODING_AGENT_DIR: "/pi" },
      files: { "/pi/auth.json": JSON.stringify({ openai: { type: "oauth", access: payload ? jwt(payload) : "invalid" } }) },
      fetch: async () => { calls++; return Response.json(plan); },
    });
    const previous = configurePlatform(memory.runtime);
    try {
      const result = await queryQuota({ accessToken: "codex-token" }, { retries: 1 });
      assert.equal(calls, 1);
      assert.equal(result.model_remains[1].interval.remaining_percent, 20);
    } finally {
      configurePlatform(previous);
    }
  }
});
