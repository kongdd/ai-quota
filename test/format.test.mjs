import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReport } from "../dist/format.js";

const items = [{ model_name: "MiniMax" }];

for (const compact of [false, true]) {
  test(`report header includes Pacific time (compact=${compact})`, () => {
    for (const [iso, pacific] of [
      ["2026-01-25T05:32:00Z", "PST 2026-01-24 21:32:00"],
      ["2026-10-25T05:32:00Z", "PDT 2026-10-24 22:32:00"],
      ["2026-10-25T07:32:00Z", "PDT 2026-10-25 00:32:00"],
    ]) {
      const date = new Date(iso);
      const header = renderReport(items, date.getTime(), undefined, compact).split("\n")[0];
      assert.equal(header, `${date.toLocaleString("sv-SE", { hour12: false })} (${pacific})`);
    }
  });
}
