import assert from "node:assert/strict";
import { test } from "node:test";
import { targetsOf, visibleModels } from "../src/display.ts";
import { mergeProvider, type Provider, type ProviderSnapshot } from "../src/types.ts";

const failed = (provider: Provider, message: string): ProviderSnapshot => ({
  provider,
  status: "error",
  error: { code: "unknown", message, retryable: false },
});

test("single-provider refresh only replaces that provider", () => {
  const claude = failed("claude", "old");
  const openai = failed("openai", "old");
  const refreshed = failed("openai", "new");

  assert.deepEqual(mergeProvider([claude, openai], refreshed), [claude, refreshed]);
  assert.deepEqual(mergeProvider([claude], openai), [claude, openai]);
});

test("OpenAI apps are hidden from cards and tray targets without changing source data", () => {
  const provider: ProviderSnapshot = {
    provider: "openai",
    status: "ok",
    models: [
      { name: "codex·plus", windows: { short: window(80) } },
      { name: "openai · apps", windows: { short: window(20), weekly: window(90) } },
    ],
  };

  assert.deepEqual(visibleModels(provider).map((model) => model.name), ["codex·plus"]);
  assert.equal(provider.models.length, 2);
  assert.deepEqual(targetsOf([provider]).map((target) => [target.label, target.text, target.tone]), [
    ["OpenAI · codex·plus 短", "20%", "safe"],
  ]);
});

function window(remainingPercent: number) {
  return {
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetsAt: "2026-10-04T00:00:00.000Z",
    resetsInMs: 60_000,
    status: remainingPercent > 0 ? "available" as const : "exhausted" as const,
  };
}
