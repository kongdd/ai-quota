import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/earthengine/ee-quota.js", import.meta.url));

function setup({ cred } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ee-quota-"));
  const credPath = join(home, "credentials");
  if (cred) writeFileSync(credPath, JSON.stringify(cred));
  return {
    run(args) {
      return spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: home, EARTHENGINE_CREDENTIALS: credPath },
        timeout: 10_000,
      });
    },
  };
}

test("auth enable/disable/list", () => {
  const { run } = setup();
  assert.match(run(["auth", "enable", "gee-hydro"]).stdout, /enabled gee-hydro/);
  run(["auth", "enable", "gee-kongdd"]);
  assert.match(run(["auth", "disable", "gee-kongdd"]).stdout, /disabled gee-kongdd/);
  const list = run(["auth", "list"]).stdout;
  assert.match(list, /gee-hydro\s+enabled/);
  assert.match(list, /gee-kongdd\s+disabled/);
});

test("empty map falls back to credentials project", () => {
  const { run } = setup({ cred: { project: "gee-hydro" } });
  const list = run(["auth", "list"]).stdout;
  assert.match(list, /gee-hydro\s+enabled/);
  assert.doesNotMatch(list, /gee-kongdd/);
  const out = run(["--no-live"]).stdout;
  assert.match(out, /gee-hydro/);
  assert.doesNotMatch(out, /gee-kongdd/);
});

test("non-empty map ignores credentials project", () => {
  const { run } = setup({ cred: { project: "gee-hydro" } });
  run(["auth", "enable", "gee-kongdd"]);
  const list = run(["auth", "list"]).stdout;
  assert.doesNotMatch(list, /gee-hydro/);
  assert.match(list, /gee-kongdd\s+enabled/);
  const out = run(["--no-live"]).stdout;
  assert.match(out, /gee-kongdd/);
  assert.doesNotMatch(out, /gee-hydro/);
});

test("-p bypasses auth filter", () => {
  const { run } = setup();
  const out = run(["-p", "gee-hydro,gee-kongdd", "--no-live"]).stdout;
  assert.match(out, /gee-hydro/);
  assert.match(out, /gee-kongdd/);
});

test("query fails when nothing is enabled", () => {
  const { run } = setup();
  const r = run(["--no-live"]);
  assert.match(r.stderr, /no projects enabled/);
});
