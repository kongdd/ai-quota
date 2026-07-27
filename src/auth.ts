import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 用户可独立启用/禁用的 provider —— 决定 `ai-quota` 默认查询哪些源。 */
export const KNOWN_PROVIDERS = ["minimax", "openai", "claude", "opencode", "deepseek-api", "grok", "kimi", "zhipu"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** provider 内部的 plan —— 决定默认渲染时哪些 plan 行被隐藏。 */
export const KNOWN_PLANS = ["minimax-video"] as const;
export type KnownPlan = (typeof KNOWN_PLANS)[number];

/** 所有可被 `auth enable/disable` 操控的项目。 */
export const KNOWN_ITEMS = [...KNOWN_PROVIDERS, ...KNOWN_PLANS] as const;
export type KnownItem = (typeof KNOWN_ITEMS)[number];

export type AuthConfig = Partial<Record<KnownItem, boolean>>;

/** 项目缺省值 —— provider 默认启用；可选 plan 默认禁用。 */
const DEFAULTS: Record<KnownItem, boolean> = {
  minimax: true,
  openai: true,
  claude: true,
  opencode: true,
  "deepseek-api": true,
  grok: true,
  kimi: true,
  zhipu: true,
  "minimax-video": false,
};

/** 配置文件路径：遵循 XDG，$XDG_CONFIG_HOME 未设时回退 ~/.config */
export function authConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "ai-quota", "auth.json");
}

/** 读取配置；文件不存在或解析失败时返回空对象（让 DEFAULTS 兜底）。 */
export function loadAuthConfig(): AuthConfig {
  const path = authConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuthConfig;
  } catch {
    return {};
  }
}

/** 写配置：自动建父目录；写入始终是合法 JSON。 */
export function saveAuthConfig(cfg: AuthConfig): void {
  const path = authConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

/** 给定项目名，返回当前是否启用。文件里没写明时按 DEFAULTS 兜底。 */
export function isEnabled(cfg: AuthConfig, name: string): boolean {
  const v = cfg[name as KnownItem];
  if (v === true || v === false) return v;
  return DEFAULTS[name as KnownItem] ?? true;
}

/** 大小写不敏感地把用户传入的字符串归一到 KNOWN_ITEMS，未匹配返回 undefined。 */
export function normalizeName(raw: string): KnownItem | undefined {
  const lower = raw.toLowerCase().trim();
  return KNOWN_ITEMS.find((k) => k.toLowerCase() === lower);
}

/** pi agent 默认 auth.json 路径：`$PI_CONFIG_DIR/auth.json` 或 `~/.pi/agent/auth.json`。 */
export function piAgentAuthPath(): string {
  if (process.env.PI_CONFIG_DIR) return join(process.env.PI_CONFIG_DIR, "auth.json");
  return join(homedir(), ".pi", "agent", "auth.json");
}

/** 从 pi agent auth.json 读取 `entryName` 条目；文件不存在/JSON 错/条目不是对象时返回 `undefined`。 */
export function readPiAuthEntry(entryName: string, authPath = piAgentAuthPath()): Record<string, unknown> | undefined {
  const root = tryReadJsonFile(authPath);
  if (!root || typeof root !== "object") return undefined;
  const entry = (root as Record<string, unknown>)[entryName];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

/** 从 pi agent auth.json 读取 `entryName` 条目下的 api key；支持 `key / access / access_token / token` 字段。 */
export function loadPiAuthKey(entryName: string, authPath = piAgentAuthPath()): string | undefined {
  const e = readPiAuthEntry(entryName, authPath);
  if (!e) return undefined;
  const raw = e.key ?? e.access ?? e.access_token ?? e.token;
  const key = typeof raw === "string" ? raw.trim() : "";
  return key || undefined;
}

/** 读取并解析 auth.json；文件缺失或 JSON 失败抛错（调用方决定怎么映射到自己的 error 类型）。 */
export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 同 `readJsonFile`，但失败时返回 `undefined`（可选读取）。 */
export function tryReadJsonFile(path: string): unknown {
  try {
    return readJsonFile(path);
  } catch {
    return undefined;
  }
}