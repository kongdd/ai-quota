import assert from "node:assert/strict";
import { test } from "node:test";
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
