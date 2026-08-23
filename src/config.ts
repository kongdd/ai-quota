import { dirname, env, existsSync, homedir, join, mkdirSync, readFileSync, writeFileSync } from "./platform.js";

export type OpencodeGoLongWindow = "weekly" | "monthly";
export type OpencodeGoLongPeriod = "1w" | "1m";

type AiQuotaConfig = {
  opencodeGo?: { long?: string };
};

export function aiQuotaConfigPath(): string {
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "ai-quota", "config.json");
}

function loadRawConfig(): AiQuotaConfig {
  const path = aiQuotaConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AiQuotaConfig;
  } catch {
    return {};
  }
}

function saveRawConfig(cfg: AiQuotaConfig): void {
  const path = aiQuotaConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function periodToLongWindow(period: OpencodeGoLongPeriod): OpencodeGoLongWindow {
  return period === "1w" ? "weekly" : "monthly";
}

export function parseOpencodeGoLongPeriod(raw: string): OpencodeGoLongPeriod {
  const s = raw.trim().toLowerCase();
  if (s === "1w") return "1w";
  if (s === "1m") return "1m";
  throw new Error(`--long requires 1w or 1m, got "${raw}"`);
}

export function getOpencodeGoLongPeriod(): OpencodeGoLongPeriod {
  const stored = loadRawConfig().opencodeGo?.long?.trim().toLowerCase();
  if (stored === "1w" || stored === "1m") return stored;
  return "1m";
}

export function setOpencodeGoLongPeriod(period: OpencodeGoLongPeriod): void {
  const cfg = loadRawConfig();
  cfg.opencodeGo = { ...cfg.opencodeGo, long: period };
  saveRawConfig(cfg);
}

/** 查询时长窗口：`--long` 单次覆盖，否则 `config.json`。 */
export function resolveOpencodeGoLongWindowForQuery(override?: OpencodeGoLongPeriod): OpencodeGoLongWindow {
  const period = override ?? getOpencodeGoLongPeriod();
  return periodToLongWindow(period);
}