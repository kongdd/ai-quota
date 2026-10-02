import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultEnabled, piAgentAuthPath, piAuthCandidatePaths } from "../dist/auth.js";
import { configurePlatform, memoryPlatform } from "../dist/platform.js";
import { queryCodexResetSnapshot, queryQuotaSnapshot, quotaSnapshot } from "../dist/query.js";
import { queryQuota } from "../dist/provider/openai.js";
import { renderReport } from "../dist/format.js";

const direct = {
  type: "oauth",
  access: "direct-token",
  clientId: "oaiapp_test",
  scopes: ["chatgpt.tokens.use.direct"],
};
const legacy = { type: "oauth", access: "legacy-token", accountId: "account" };
const codex = { auth_mode: "chatgpt", tokens: { access_token: "codex-token", account_id: "account" } };

test("Pi OpenAI direct OAuth is detected but never sent to legacy quota endpoints", async () => {
  for (const scenario of [
    { auth: { openai: direct }, enabled: true },
    { auth: { openai: direct, "openai-codex": legacy }, enabled: true, token: "legacy-token" },
    { auth: { openai: direct }, codex, enabled: true, token: "codex-token" },
    { auth: { "openai-codex": legacy }, enabled: true, token: "legacy-token" },
    { auth: { openai: { type: "api_key", key: "sk-test" } }, enabled: false },
  ]) {
    const calls = [];
    const memory = memoryPlatform({
      env: { PI_CODING_AGENT_DIR: "/pi", PI_CONFIG_DIR: "/ignored", CODEX_HOME: "/codex" },
      files: {
        "/pi/auth.json": JSON.stringify(scenario.auth),
        ...(scenario.codex ? { "/codex/auth.json": JSON.stringify(scenario.codex) } : {}),
      },
      fetch: async (input, init) => {
        assert.equal(init.headers.Authorization, `Bearer ${scenario.token}`);
        assert.equal(init.headers["chatgpt-account-id"], "account");
        const url = String(input);
        calls.push(url);
        return Response.json(url.endsWith("reset-credits") ? { available_count: 2 } : {
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 20, reset_at: 2_000_000_000 },
            secondary_window: { used_percent: 30, reset_at: 2_000_600_000 },
          },
        });
      },
    });
    const previous = configurePlatform(memory.runtime);
    try {
      assert.equal(piAgentAuthPath(), "/pi/auth.json");
      assert.deepEqual(piAuthCandidatePaths(), ["/pi/auth.json"]);
      assert.equal(defaultEnabled("openai"), scenario.enabled);
      const snapshot = await queryQuotaSnapshot();
      if (!scenario.enabled) {
        assert.deepEqual(snapshot.providers, []);
      } else if (scenario.token) {
        assert.equal(snapshot.providers[0].status, "ok");
        const model = snapshot.providers[0].models[0];
        assert.equal(model.windows.short.remainingPercent, 80);
        assert.equal(model.windows.weekly.remainingPercent, 70);
        const reset = await queryCodexResetSnapshot();
        assert.equal(reset.status, "ok");
        assert.equal(reset.availableCount, 2);
      } else {
        assert.equal(snapshot.providers[0].status, "error");
        assert.match(snapshot.providers[0].error.message, /cannot read ChatGPT usage/);
        assert.equal(snapshot.providers[0].error.retryable, false);
        const reset = await queryCodexResetSnapshot();
        assert.equal(reset.status, "error");
        assert.match(reset.error.message, /chatgpt.com\/settings\/usage/);
        assert.equal(reset.error.retryable, false);
      }
      assert.equal(calls.length, scenario.token ? 2 : 0);
      assert.deepEqual(memory.writes(), {});
    } finally {
      configurePlatform(previous);
    }
  }
});

test("ChatPass shared-app quotas use duration, preserve missing windows, and render independently", async () => {
  const short = { used_percent: 9, limit_window_seconds: 18_000, reset_at: 2_000_000_000 };
  const weekly = { used_percent: 2, limit_window_seconds: 604_800, reset_at: 2_000_600_000 };
  for (const scenario of [
    {}, // 真实 WHAM 响应可完全缺少 chatpass，不能补造共享额度。
    { windows: [weekly, short], shortLeft: 91, weekLeft: 98 },
    { windows: [weekly], weekLeft: 98 },
    { windows: [short], shortLeft: 91 },
    { windows: [{ ...weekly, used_percent: 110 }], weekLeft: 0 },
    { windows: [{ ...weekly, used_percent: "invalid" }] },
    { windows: [{ ...weekly, limit_window_seconds: 3_600 }] },
    { windows: [] },
    { windows: null },
    { windows: {} },
  ]) {
    const memory = memoryPlatform({
      fetch: async (_input, init) => {
        assert.equal(init.headers["OAI-App-Brand"], "chatgpt");
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { ...short, used_percent: 20 } },
          ...(scenario.windows === undefined ? {} : { chatpass: { windows: scenario.windows } }),
        });
      },
    });
    const previous = configurePlatform(memory.runtime);
    try {
      const response = await queryQuota({ accessToken: "legacy-token" }, { retries: 1 });
      const result = quotaSnapshot([{ name: "openai", ok: true, items: response.model_remains }]);
      const [codexModel, apps] = result.providers[0].models;
      assert.equal(codexModel.windows.short.remainingPercent, 80);
      assert.equal(codexModel.windows.weekly.remainingPercent, 80);
      if (scenario.shortLeft === undefined && scenario.weekLeft === undefined) {
        assert.equal(apps, undefined);
        assert.equal(result.providers[0].models.length, 1);
        continue;
      }
      assert.equal(apps.name, "openai · apps");
      assert.equal(apps.windows.short?.remainingPercent, scenario.shortLeft);
      assert.equal(apps.windows.weekly?.remainingPercent, scenario.weekLeft);
      const model = response.model_remains[1];
      const compact = renderReport([model], Date.now(), "", true);
      if (scenario.shortLeft === undefined) assert.doesNotMatch(compact, /5h/);
      else assert.match(compact, /5h/);
      if (scenario.weekLeft === undefined) assert.doesNotMatch(compact, /wk/);
      else assert.match(compact, /wk/);
      assert.doesNotMatch(renderReport([model], Date.now(), "", false), /NaN|undefined/);
    } finally {
      configurePlatform(previous);
    }
  }
});
