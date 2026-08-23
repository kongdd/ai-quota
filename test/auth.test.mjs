import assert from "node:assert/strict";
import { test } from "node:test";
import { piAuthCandidatePaths } from "../dist/auth.js";

test("WSL candidate auth includes Windows pi auth from PATH", () => {
  const m = (process.env.PATH ?? "").match(/\/mnt\/[a-z]\/Users\/[^/]+/);
  if (!m) return;
  assert.ok(piAuthCandidatePaths().some((p) => p.startsWith(m[0])));
});
