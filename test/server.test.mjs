import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApiServer } from "../dist/server.js";

const quota = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "ok",
  providers: [],
};
const reset = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  provider: "openai",
  status: "ok",
  availableCount: 1,
  credits: [{ status: "available", title: "Reset" }],
};

let server;
let baseUrl;

before(async () => {
  server = createApiServer({
    token: "test-token",
    query: async () => quota,
    queryCodexReset: async () => reset,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

test("health is public", async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(response.status, 200);
});

test("quota endpoints require bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/v1/quotas`);
  assert.equal(response.status, 401);
});

test("returns Codex reset cards", async () => {
  const response = await fetch(`${baseUrl}/api/v1/codex/reset-cards`, {
    headers: { Authorization: "Bearer test-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reset);
});
