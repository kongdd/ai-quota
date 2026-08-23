import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { configurePlatform } from "./platform.js";

configurePlatform({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  fetch: (...args) => globalThis.fetch(...args),
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
  mkdir: (path) => { mkdirSync(path, { recursive: true }); },
  copy: copyFileSync,
  join,
  dirname,
  randomUUID,
});
