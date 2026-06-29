import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRemain, QuotaResponse } from "./minimax.js";

/** OpenCode account server 默认地址 —— 自建可设 `$OPENCODE_SERVER` 覆盖 */
const DEFAULT_SERVER = "https://opencode.ai";

export class OpencodeAuthError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "OpencodeAuthError";
  }
}

/**
 * OpenCode Go dashboard 抓取的会话配置。
 * 来源：环境变量 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`（也支持从 `opencode.env` 自动加载）。
 * 这两个值必须从浏览器 DevTools 提取，因为 OpenCode CLI 的 `auth.json` 只保存 API Bearer，不保存 web session。
 */
export interface OpencodeGoConfig {
  workspaceId: string;
  authCookie: string;
}

interface ScrapedWindow {
  usagePercent: number;
  resetInSec: number;
}

/** 平台相关的 ai-quota 配置目录（用于 opencode.env 自动加载）。
 *  - Linux/macOS：$XDG_CONFIG_HOME/ai-quota 或 ~/.config/ai-quota
 *  - Windows：%APPDATA%\ai-quota（漫游配置，符合 Windows 习惯）
 *  ponytail: 用户设了 $OPENCODE_GO_ENV 直接覆盖。 */
function defaultEnvPath(): string {
  if (process.env.OPENCODE_GO_ENV) return process.env.OPENCODE_GO_ENV;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "ai-quota", "opencode.env");
  }
  return join(homedir(), ".config", "ai-quota", "opencode.env");
}

/** 从环境变量（或自动加载的 `opencode.env`）读 dashboard 抓取配置；任一缺失返回 undefined */
export function loadOpencodeGoConfig(): OpencodeGoConfig | undefined {
  let workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  let authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();

  // 从平台相关的 env 文件自动加载（仅当 env 没设；shell-style KEY=VALUE，可带 export）
  if (!workspaceId || !authCookie) {
    try {
      const raw = readFileSync(defaultEnvPath(), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, key, val] = m;
        const unquoted = val!.replace(/^['"]|['"]$/g, "");
        if (key === "OPENCODE_GO_WORKSPACE_ID" && !workspaceId) workspaceId = unquoted;
        else if (key === "OPENCODE_GO_AUTH_COOKIE" && !authCookie) authCookie = unquoted;
      }
    } catch {
      // 文件不存在/不可读 → 静默忽略
    }
  }

  if (!workspaceId || !authCookie) return undefined;
  return { workspaceId, authCookie };
}

/* ------------------------------------------------------------------ *
 * Dashboard HTML 解析 —— SolidJS SSR 输出格式：
 *   `rollingUsage:$R[N]={status:"ok",resetInSec:12640,usagePercent:5}`
 *   `weeklyUsage:$R[N]={status:"ok",resetInSec:588526,usagePercent:67.2}`
 * monthly 字段虽然存在但不渲染（控制台单独看），省去解析开销。
 * ------------------------------------------------------------------ */

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
/** 返回两个 RegExp：[usagePercent 在前, resetInSec 在前]，让调用方按命中顺序决定哪个 group 是哪个字段 */
const RE_SSR_WINDOW = (field: string): RegExp[] => [
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\\}`),
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\\}`),
];

const RE_ROLLING = RE_SSR_WINDOW("rollingUsage");
const RE_WEEKLY = RE_SSR_WINDOW("weeklyUsage");

function parseSsrWindow(html: string, patterns: RegExp[]): ScrapedWindow | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    // patterns[0] = usagePercent 在 group[1]；patterns[1] = resetInSec 在 group[1]
    const usagePercent = Number(re === patterns[0] ? m[1] : m[2]);
    const resetInSec = Number(re === patterns[0] ? m[2] : m[1]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec };
  }
  return null;
}

/** 把 rolling/weekly 两窗口归一到单行 ModelRemain（5h → interval、weekly → weekly）。
 *  ponytail: 不支持单字段缺失 —— SSR 是 all-or-nothing，要么三个都有要么全没。 */
function windowsToModelRemains(windows: { rolling: ScrapedWindow; weekly: ScrapedWindow }): ModelRemain[] {
  const now = Date.now();
  const fill = (w: ScrapedWindow): { remaining_percent: number; remains_time: number; end_time: number; status: number } => {
    const usage = Math.max(0, Math.min(100, w.usagePercent));
    const endMs = now + Math.max(0, w.resetInSec) * 1000;
    return {
      remaining_percent: 100 - usage,
      remains_time: Math.max(0, endMs - now),
      end_time: endMs,
      status: usage >= 100 ? 3 : 1,
    };
  };
  return [{ model_name: "opencode-go", interval: fill(windows.rolling), weekly: fill(windows.weekly) }];
}

/** 从 dashboard HTML 抓 rolling/weekly 两窗口的使用率。
 *  cookie 失效 → 302 跳登录页（fetch with `redirect: "manual"` 把跳转换成 status 0 的 opaqueredirect）。 */
export async function scrapeOpencodeGoDashboard(
  cfg: OpencodeGoConfig,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<ModelRemain[]> {
  const baseUrl = opts.baseUrl ?? process.env.OPENCODE_SERVER ?? DEFAULT_SERVER;
  const url = `${baseUrl}/workspace/${encodeURIComponent(cfg.workspaceId)}/go`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: `auth=${cfg.authCookie}`,
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0",
      },
      signal: ctrl.signal,
      redirect: "manual",
    });
    // opaqueredirect（status 0）+ 直接 401/403 都视为鉴权失败
    if (resp.status === 0 || resp.status === 401 || resp.status === 403) {
      throw new OpencodeAuthError(`dashboard auth failed — refresh \$OPENCODE_GO_AUTH_COOKIE`, false);
    }
    if (!resp.ok) {
      throw new OpencodeAuthError(`dashboard HTTP ${resp.status}`, resp.status >= 500);
    }
    const html = await resp.text();

    const rolling = parseSsrWindow(html, RE_ROLLING);
    const weekly = parseSsrWindow(html, RE_WEEKLY);
    if (!rolling || !weekly) {
      throw new OpencodeAuthError("dashboard parse failed: rolling/weekly usage not found", false);
    }
    return windowsToModelRemains({ rolling, weekly });
  } catch (e) {
    if (e instanceof OpencodeAuthError) throw e;
    throw new OpencodeAuthError(`dashboard: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取 OpenCode Go 配额：抓取 workspace dashboard 页面，
 * 正则解析 rolling + weekly 两窗口的使用率。
 *
 * 需要设 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`，
 * 可通过 env 或 `~/.config/ai-quota/opencode.env` 配置。
 */
export async function queryQuota(
  opts: { timeoutMs?: number } = {},
): Promise<QuotaResponse> {
  const dashCfg = loadOpencodeGoConfig();
  if (!dashCfg) {
    throw new OpencodeAuthError(
      "OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE not set — configure via env or ~/.config/ai-quota/opencode.env",
      false,
    );
  }
  const items = await scrapeOpencodeGoDashboard(dashCfg, { timeoutMs: opts.timeoutMs });
  return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: items };
}
