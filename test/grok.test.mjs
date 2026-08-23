import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../dist/node-platform.js";
import { queryQuota } from "../dist/provider/grok.js";

test("Grok mirrors weekly quota when monthly quota is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-quota-grok-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ xai: { type: "oauth", access: "test" } }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => Response.json({
    config: String(url).includes("format=credits")
      ? {
          creditUsagePercent: 2,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2030-01-08T00:00:00Z" },
        }
      : {
          monthlyLimit: { val: 0 },
          used: { val: 0 },
          billingPeriodEnd: "2030-02-01T00:00:00Z",
        },
  });

  try {
    const [grok] = (await queryQuota({ authPath })).model_remains;
    assert.deepEqual(grok.weekly, grok.interval);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true });
  }
});
