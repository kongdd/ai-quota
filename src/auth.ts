import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 用户可独立启用/禁用的 provider —— 决定 `ai-quota` 默认查询哪些源。 */
export const KNOWN_PROVIDERS = ["minimax", "openai", "claude", "opencode", "deepseek-api"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** provider 内部的 plan —— 决定默认渲染时哪些 plan 行被隐藏。
 *  MiniMax video 被硬编码隐藏（不列入 KNOWN_PLANS，auth 也救不回来）。 */
export const KNOWN_PLANS: readonly string[] = [];
export type KnownPlan = string;

/** 所有可被 `auth enable/disable` 操控的项目。 */
export const KNOWN_ITEMS = [...KNOWN_PROVIDERS, ...KNOWN_PLANS] as const;
export type KnownItem = (typeof KNOWN_ITEMS)[number];

export type AuthConfig = Partial<Record<KnownItem, boolean>>;

/** 项目缺省值 —— 文件里没写明的项走这里。provider 默认启用；plan 列表为空（video 由 render 阶段硬过滤）。 */
const DEFAULTS: Record<KnownProvider, boolean> = {
  minimax: true,
  openai: true,
  claude: true,
  opencode: true,
  "deepseek-api": true,
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
  return DEFAULTS[name as KnownProvider] ?? true;
}

/** 大小写不敏感地把用户传入的字符串归一到 KNOWN_ITEMS，未匹配返回 undefined。 */
export function normalizeName(raw: string): KnownItem | undefined {
  const lower = raw.toLowerCase().trim();
  return KNOWN_ITEMS.find((k) => k.toLowerCase() === lower);
}