import { readPiAuthEntry } from "../auth.js";
import { fetchQuota } from "../platform.js";
import type { QuotaResponse } from "./minimax.js";

export class CopilotError extends Error {
  constructor(message: string, public retryable = false, public status?: number) {
    super(message);
    this.name = "CopilotError";
  }
}

interface RawUsage {
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: {
    premium_interactions?: {
      percent_remaining?: number;
      unlimited?: boolean;
      has_quota?: boolean;
    };
  };
}

/** Pi 的 refresh 是 GitHub OAuth token；access 是短期 Copilot token，不能读取账单。 */
export async function queryQuota(
  opts: { authPath?: string; timeoutMs?: number } = {},
): Promise<QuotaResponse> {
  const entry = readPiAuthEntry("github-copilot", opts.authPath);
  const token = typeof entry?.refresh === "string" ? entry.refresh.trim() : "";
  if (entry?.type !== "oauth" || !token) {
    throw new CopilotError(
      "GitHub Copilot credentials missing — login with pi `/login github-copilot` (auth.json requires OAuth refresh)",
      false,
      401,
    );
  }

  let domain = "github.com";
  if (typeof entry.enterpriseUrl === "string" && entry.enterpriseUrl.trim()) {
    try {
      const url = entry.enterpriseUrl.trim();
      domain = new URL(url.includes("://") ? url : `https://${url}`).hostname;
    } catch {
      throw new CopilotError("GitHub Copilot enterpriseUrl must be a valid domain");
    }
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchQuota(`https://api.${domain}/copilot_internal/user`, {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new CopilotError("GitHub Copilot authorization failed — re-login with pi `/login github-copilot`", false, resp.status);
    }
    if (!resp.ok) {
      throw new CopilotError(`GitHub Copilot usage returned HTTP ${resp.status}`, resp.status === 429 || resp.status >= 500, resp.status);
    }

    const data = await resp.json() as RawUsage | null;
    const quota = data?.quota_snapshots?.premium_interactions;
    if (quota?.unlimited) throw new CopilotError("GitHub Copilot premium quota is unlimited; no usage percentage available");
    const remaining = quota?.percent_remaining;
    const endTime = Date.parse(data?.quota_reset_date_utc ?? data?.quota_reset_date ?? "");
    if (quota?.has_quota === false || typeof remaining !== "number" || !Number.isFinite(remaining) || !Number.isFinite(endTime)) {
      throw new CopilotError("Invalid GitHub Copilot usage payload: monthly quota or reset date missing");
    }

    // 首列显示月度 included credits / premium requests；JSON 中映射为 monthly。
    return {
      base_resp: { status_code: 0, status_msg: "ok" },
      model_remains: [{
        model_name: "github-copilot",
        interval: {
          remaining_percent: Math.max(0, Math.min(100, remaining)),
          remains_time: Math.max(0, endTime - Date.now()),
          end_time: endTime,
          status: remaining <= 0 ? 3 : 1,
        },
      }],
    };
  } catch (e) {
    if (e instanceof CopilotError) throw e;
    if (ctrl.signal.aborted) throw new CopilotError(`GitHub Copilot timeout after ${timeoutMs}ms`, true);
    if (e instanceof SyntaxError) throw new CopilotError("Invalid GitHub Copilot usage JSON");
    throw new CopilotError(`GitHub Copilot network: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
  }
}
