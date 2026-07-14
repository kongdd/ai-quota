import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRemain, QuotaResponse } from "./minimax.js";
import {
  resolveOpencodeGoLongWindowForQuery,
  type OpencodeGoLongWindow,
} from "../opencode-config.js";

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

function defaultEnvPath(): string {
  if (process.env.OPENCODE_GO_ENV) return process.env.OPENCODE_GO_ENV;
  return join(homedir(), ".config", "ai-quota", "opencode.env");
}

type OpencodeEnvVars = {
  workspaceId?: string;
  authCookie?: string;
};

function loadOpencodeEnvFile(): OpencodeEnvVars {
  const out: OpencodeEnvVars = {};
  try {
    const raw = readFileSync(defaultEnvPath(), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const [, key, val] = m;
      const unquoted = val!.replace(/^['"]|['"]$/g, "");
      if (key === "OPENCODE_GO_WORKSPACE_ID" && out.workspaceId === undefined) out.workspaceId = unquoted;
      else if (key === "OPENCODE_GO_AUTH_COOKIE" && out.authCookie === undefined) out.authCookie = unquoted;
    }
  } catch {
    // 文件不存在/不可读 → 静默忽略
  }
  return out;
}

/** 从环境变量（或自动加载的 `opencode.env`）读 dashboard 抓取配置；任一缺失返回 undefined */
export function loadOpencodeGoConfig(): OpencodeGoConfig | undefined {
  const file = loadOpencodeEnvFile();
  const workspaceId = (process.env.OPENCODE_GO_WORKSPACE_ID?.trim() || file.workspaceId)?.trim();
  const authCookie = (process.env.OPENCODE_GO_AUTH_COOKIE?.trim() || file.authCookie)?.trim();
  if (!workspaceId || !authCookie) return undefined;
  return { workspaceId, authCookie };
}

/* ------------------------------------------------------------------ *
 * Dashboard HTML 解析 —— SolidJS SSR 输出格式：
 *   `rollingUsage:$R[N]={status:"ok",resetInSec:12640,usagePercent:5}`
 *   `weeklyUsage:$R[N]={status:"ok",resetInSec:588526,usagePercent:67.2}`
 *   `monthlyUsage:$R[N]={status:"ok",resetInSec:...,usagePercent:...}`
 * 展示：rolling → interval；weekly 或 monthly → 第二列（`ai-quota config long 1w|1m`）。
 * ------------------------------------------------------------------ */

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
/** 返回两个 RegExp：[usagePercent 在前, resetInSec 在前]，让调用方按命中顺序决定哪个 group 是哪个字段 */
const RE_SSR_WINDOW = (field: string): RegExp[] => [
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\\}`),
  new RegExp(`${field}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\\}`),
];

const RE_ROLLING = RE_SSR_WINDOW("rollingUsage");
const RE_WEEKLY = RE_SSR_WINDOW("weeklyUsage");
const RE_MONTHLY = RE_SSR_WINDOW("monthlyUsage");

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

function fillWindow(w: ScrapedWindow, now: number) {
  const usage = Math.max(0, Math.min(100, w.usagePercent));
  const endMs = now + Math.max(0, w.resetInSec) * 1000;
  return {
    remaining_percent: 100 - usage,
    remains_time: Math.max(0, endMs - now),
    end_time: endMs,
    status: usage >= 100 ? 3 : 1,
  };
}

/** rolling → interval；long → weekly 列。 */
function windowsToModelRemains(windows: { rolling: ScrapedWindow; long: ScrapedWindow }): ModelRemain[] {
  const now = Date.now();
  return [{ model_name: "opencode-go", interval: fillWindow(windows.rolling, now), weekly: fillWindow(windows.long, now) }];
}

/** rolling / weekly / monthly → 三列（5h / 1w / 1m）。 */
function windowsToModelRemainsAll(windows: {
  rolling: ScrapedWindow;
  weekly: ScrapedWindow;
  monthly: ScrapedWindow;
}): ModelRemain[] {
  const now = Date.now();
  return [
    {
      model_name: "opencode-go",
      interval: fillWindow(windows.rolling, now),
      weekly: fillWindow(windows.weekly, now),
      monthly: fillWindow(windows.monthly, now),
    },
  ];
}

/** 从 dashboard HTML 抓 rolling + 所选长窗口的使用率。
 *  cookie 失效 → 302 跳登录页（fetch with `redirect: "manual"` 把跳转换成 status 0 的 opaqueredirect）。 */
export async function scrapeOpencodeGoDashboard(
  cfg: OpencodeGoConfig,
  opts: {
    baseUrl?: string;
    timeoutMs?: number;
    longWindow?: OpencodeGoLongWindow;
    allWindows?: boolean;
  } = {},
): Promise<ModelRemain[]> {
  const allWindows = opts.allWindows === true;
  const longWindow = opts.longWindow ?? "monthly";
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
    const monthly = parseSsrWindow(html, RE_MONTHLY);
    if (allWindows) {
      if (!rolling || !weekly || !monthly) {
        throw new OpencodeAuthError("dashboard parse failed: rolling/weekly/monthly usage not found", false);
      }
      return windowsToModelRemainsAll({ rolling, weekly, monthly });
    }
    const long = longWindow === "weekly" ? weekly : monthly;
    const longLabel = longWindow === "weekly" ? "weeklyUsage" : "monthlyUsage";
    if (!rolling || !long) {
      throw new OpencodeAuthError(`dashboard parse failed: rolling/${longLabel} not found`, false);
    }
    return windowsToModelRemains({ rolling, long });
  } catch (e) {
    if (e instanceof OpencodeAuthError) throw e;
    throw new OpencodeAuthError(`dashboard: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取 OpenCode Go 配额：抓取 workspace dashboard 页面，
 * 正则解析 rolling + weekly|monthly（次列由 longWindow 决定，默认 monthly）。
 *
 * 需要设 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`，
 * 可通过 env 或 `~/.config/ai-quota/opencode.env` 配置。
 */
export async function queryQuota(
  opts: { timeoutMs?: number; longWindow?: OpencodeGoLongWindow; allWindows?: boolean } = {},
): Promise<QuotaResponse> {
  const dashCfg = loadOpencodeGoConfig();
  if (!dashCfg) {
    throw new OpencodeAuthError(
      "OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE not set — configure via env or ~/.config/ai-quota/opencode.env",
      false,
    );
  }
  const scrapeOpts: Parameters<typeof scrapeOpencodeGoDashboard>[1] = { timeoutMs: opts.timeoutMs };
  if (opts.allWindows) scrapeOpts.allWindows = true;
  else scrapeOpts.longWindow = opts.longWindow ?? resolveOpencodeGoLongWindowForQuery();
  const items = await scrapeOpencodeGoDashboard(dashCfg, scrapeOpts);
  return { base_resp: { status_code: 0, status_msg: "ok" }, model_remains: items };
}
