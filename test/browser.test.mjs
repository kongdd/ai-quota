import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { piAgentAuthPath } from "../dist/auth.js";
import { queryBrowserQuota } from "../dist/browser.js";
import { errorSnapshot, quotaSnapshot, runQuotaQuery } from "../dist/query.js";

function browserGraph(entry) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /from ["']node:|\bprocess\./, path);
    for (const match of source.matchAll(/from ["'](\.\.?\/[^"']+)["']/g)) {
      visit(join(dirname(path), match[1]));
    }
  };
  visit(entry);
}

function minimaxResponse() {
  return Response.json({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: "MiniMax-M2",
      current_interval_remaining_percent: 80,
      current_interval_status: 1,
      remains_time: 1,
      end_time: Date.now() + 1,
      current_weekly_remaining_percent: 60,
      current_weekly_status: 1,
      weekly_remains_time: 1,
      weekly_end_time: Date.now() + 1,
    }],
  });
}

test("browser core has no Node runtime dependency and restores the caller runtime", async () => {
  browserGraph(fileURLToPath(new URL("../dist/browser.js", import.meta.url)));
  const nodeAuthPath = piAgentAuthPath();
  const result = await queryBrowserQuota({
    env: { PI_CONFIG_DIR: "/pi" },
    files: { "/pi/auth.json": JSON.stringify({ "minimax-cn": { key: "test" } }) },
    fetch: async () => minimaxResponse(),
  });
  assert.equal(result.snapshot.providers[0]?.status, "ok");
  assert.deepEqual(result.writes, {});
  assert.equal(piAgentAuthPath(), nodeAuthPath);
});

test("Tauri cancellation is reported as timeout", () => {
  assert.equal(errorSnapshot(new Error("Request cancelled")).code, "timeout");
});

test("providers run in parallel and one failure returns a partial snapshot", async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runQuotaQuery(["minimax", "openai"], {}, {
    minimax: async () => {
      started += 1;
      await gate;
      return [];
    },
    openai: async () => {
      started += 1;
      throw new Error("offline");
    },
  });

  await new Promise(setImmediate);
  assert.equal(started, 2);
  release();

  const snapshot = quotaSnapshot(await pending, 0);
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.providers[0].status, "ok");
  assert.equal(snapshot.providers[1].status, "error");
});

test("browser query keeps successful providers when another provider fails", async () => {
  const calls = [];
  const result = await queryBrowserQuota({
    providers: ["minimax", "openai"],
    env: { PI_CONFIG_DIR: "/pi" },
    files: {
      "/pi/auth.json": JSON.stringify({
        "minimax-cn": { key: "test" },
        "openai-codex": { type: "oauth", access: "test" },
      }),
    },
    values: { "timeout-ms": 10, retries: 1 },
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("chatgpt.com")) throw new Error("offline");
      return minimaxResponse();
    },
  });

  assert.equal(result.snapshot.status, "partial");
  assert.equal(result.snapshot.providers[0].status, "ok");
  assert.equal(result.snapshot.providers[1].status, "error");
  assert.equal(calls.filter((url) => url.includes("chatgpt.com")).length, 1);
});

test("browser adapter persists DeepSeek spending without reducing it on top-up", async () => {
  const query = (balance, files = {}) => queryBrowserQuota({
    providers: ["deepseek-api"],
    env: { XDG_CONFIG_HOME: "/config", DEEPSEEK_API_KEY: "test" },
    files,
    fetch: async () => Response.json({
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: String(balance),
        granted_balance: "0",
        topped_up_balance: String(balance),
      }],
    }),
  });
  const baseline = await query(100);
  const spent = await query(99, baseline.writes);
  const toppedUp = await query(110, spent.writes);
  const used = (result) => result.snapshot.providers[0].models[0].windows.daily.usedPercent;
  assert.ok(used(spent) > 0);
  assert.equal(used(toppedUp), used(spent));
});
