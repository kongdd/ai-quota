import { invoke } from "@tauri-apps/api/core";
import type { Provider, QuotaSnapshot } from "./types";

export interface Config {
  target: string;
  refreshSeconds: number;
  refreshLimit: number;
  quietStart: number;
  quietEnd: number;
  paused: boolean;
}

export interface MonitorState {
  config: Config;
  snapshot: QuotaSnapshot | null;
  autoLeft: number;
  error: string;
  silent: boolean;
  revision: number;
}

const DEFAULT_CONFIG: Config = {
  target: "", refreshSeconds: 120, refreshLimit: 30, quietStart: 23, quietEnd: 8, paused: false,
};

function count(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback;
}

function hour(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.floor(n))) : fallback;
}

/** 仅用于首次迁移。Rust 接管后前端会删掉这条 localStorage。 */
export function loadConfig(): Config {
  try {
    const saved = JSON.parse(localStorage.getItem("ai-quota.desktop") ?? "{}") as Partial<Config>;
    return {
      target: typeof saved.target === "string" ? saved.target : "",
      refreshSeconds: count(saved.refreshSeconds, 120, 86400),
      refreshLimit: count(saved.refreshLimit, 30),
      quietStart: hour(saved.quietStart, 23),
      quietEnd: hour(saved.quietEnd, 8),
      paused: saved.paused === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export const startMonitor = (config: Config) => invoke<MonitorState>("start_monitor", { config });
export const getMonitor = () => invoke<MonitorState>("get_monitor");
export const configureMonitor = (config: Config) => invoke<MonitorState>("configure_monitor", { config });
export const queryQuota = (provider?: Provider) => invoke<MonitorState>("refresh_monitor", { provider });
