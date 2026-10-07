import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const triple = process.env.TAURI_ENV_TARGET_TRIPLE
  ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
const arch = triple.startsWith("aarch64") ? "arm64" : "x64";
const platform = triple.includes("windows") ? "windows" : triple.includes("darwin") ? "darwin" : "linux";
const output = `src-tauri/binaries/ai-quota-worker-${triple}${platform === "windows" ? ".exe" : ""}`;

mkdirSync(`${cwd}/src-tauri/binaries`, { recursive: true });
execFileSync("bun", [
  "build", "scripts/worker.ts", "--compile", `--target=bun-${platform}-${arch}`,
  "--outfile", output,
], { cwd, stdio: "inherit" });
