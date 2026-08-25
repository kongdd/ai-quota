import process from "node:process";
import {
  earthEngineConfigPath,
  earthEngineCredentialsPath,
  getEarthEngineAccessToken,
  enabledEeProjects,
  getEeQuotaUnit,
  isEeProjectEnabled,
  listEeProjects,
  setEeProjectEnabled,
  setEeQuotaUnit,
  type EeQuotaUnit,
} from "./earthengine.js";
const SERVICE = "earthengine.googleapis.com";
const QUOTA_API = "https://cloudquotas.googleapis.com/v1";
const MONITORING_API = "https://monitoring.googleapis.com/v3";
const MONTHLY_METRIC = `${SERVICE}/monthly_eecu_usage_time`;

export const EE_QUOTA_HELP = `Usage: ee-quota [options]

Show Earth Engine's monthly EECU quota and usage.

Options:
  -p, --project <ID>    One or more projects (repeatable or comma-separated)
  --minutes <N>         Usage lookback window (default: current month)
  --unit <s|h>          Display seconds or hours (default: configured s)
  --no-live             Skip live quota and usage lookup
  -w, --watch           Refresh in place until Ctrl+C
  -i, --interval <N>    Refresh interval (30, 30s, 1m; implies --watch)
  --json                Print the normalized result as JSON
  -h, --help            Show this help

Commands:
  ee-quota auth list
  ee-quota auth enable <PROJECT>
  ee-quota auth disable <PROJECT>
  ee-quota config set unit <s|h>
  ee-quota config --unit s|h

Earth Engine auth (managed externally): ${earthEngineCredentialsPath()}
Display config: ${earthEngineConfigPath()}
`;

interface QuotaInfo {
  metric?: unknown;
  value?: unknown;
  quotaValue?: unknown;
  effectiveLimit?: unknown;
  dimensionsInfos?: Array<{ details?: { value?: unknown }; value?: unknown; quotaValue?: unknown }>;
}

interface UsagePoint {
  value?: Record<string, unknown>;
  interval?: { endTime?: string };
}

interface Report {
  project: string;
  limitSeconds?: number;
  usedSeconds?: number;
  usageAt?: string;
  warnings: string[];
}

interface Options {
  projects?: string[];
  minutes?: number;
  unit?: EeQuotaUnit;
  noLive: boolean;
  watch: boolean;
  intervalMs: number;
  json: boolean;
}

function parseNumber(value: unknown): number | undefined {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function valueOf(info: QuotaInfo): number | undefined {
  for (const dimensions of info.dimensionsInfos ?? []) {
    const value = parseNumber(dimensions.details?.value ?? dimensions.value ?? dimensions.quotaValue);
    if (value !== undefined) return value;
  }
  return parseNumber(info.value ?? info.quotaValue ?? info.effectiveLimit);
}

function resolveProjects(options: Options): string[] {
  const requested = [...new Set(options.projects ?? [])];
  if (requested.length) return requested;
  const enabled = enabledEeProjects();
  if (!enabled.length) throw new Error("no projects enabled. Run `ee-quota auth enable <PROJECT>`");
  return enabled;
}

async function fetchJson(url: string, token: string, project: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-goog-user-project": project,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
  return (await response.json()) as Record<string, unknown>;
}

async function fetchLimit(project: string, token: string): Promise<number | undefined> {
  const parent = `projects/${encodeURIComponent(project)}/locations/global/services/${SERVICE}`;
  const url = `${QUOTA_API}/${parent}/quotaInfos?pageSize=200`;
  const payload = await fetchJson(url, token, project);
  const infos = Array.isArray(payload.quotaInfos) ? payload.quotaInfos as QuotaInfo[] : [];
  return valueOf(infos.find((info) => String(info.metric ?? "") === MONTHLY_METRIC) ?? {});
}

function pointValue(point: UsagePoint): number | undefined {
  for (const key of ["int64Value", "doubleValue", "stringValue"]) {
    const value = parseNumber(point.value?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

async function fetchUsage(project: string, token: string, minutes?: number): Promise<{ value?: number; endTime?: string }> {
  const end = new Date();
  const start = minutes === undefined
    ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
    : new Date(end.getTime() - minutes * 60_000);
  const url = new URL(`${MONITORING_API}/projects/${encodeURIComponent(project)}/timeSeries`);
  url.searchParams.set("filter", `metric.type="serviceruntime.googleapis.com/quota/allocation/usage" resource.type="consumer_quota" resource.label.service="${SERVICE}"`);
  url.searchParams.set("interval.startTime", start.toISOString());
  url.searchParams.set("interval.endTime", end.toISOString());
  url.searchParams.set("pageSize", "200");
  const payload = await fetchJson(url.toString(), token, project);
  const points: UsagePoint[] = [];
  for (const series of (Array.isArray(payload.timeSeries) ? payload.timeSeries : []) as Array<{ metric?: { labels?: Record<string, string> }; points?: UsagePoint[] }>) {
    if (series.metric?.labels?.quota_metric === MONTHLY_METRIC) points.push(...(series.points ?? []));
  }
  const latest = points
    .filter((point) => pointValue(point) !== undefined)
    .sort((a, b) => String(a.interval?.endTime ?? "").localeCompare(String(b.interval?.endTime ?? "")))
    .at(-1);
  return latest ? { value: pointValue(latest), endTime: latest.interval?.endTime } : {};
}

async function queryOne(project: string, token: string | undefined, options: Options): Promise<Report> {
  const report: Report = { project, warnings: [] };
  if (options.noLive || !token) {
    report.warnings.push("Live quota lookup skipped because --no-live was set.");
    return report;
  }
  const [limit, usage] = await Promise.allSettled([
    fetchLimit(project, token),
    fetchUsage(project, token, options.minutes),
  ]);
  if (limit.status === "fulfilled") {
    report.limitSeconds = limit.value;
    if (report.limitSeconds === undefined) report.warnings.push("Monthly quota limit was not returned by Cloud Quotas API.");
  } else {
    report.warnings.push(`Cloud Quotas API: ${limit.reason instanceof Error ? limit.reason.message : String(limit.reason)}`);
  }
  if (usage.status === "fulfilled") {
    report.usedSeconds = usage.value.value;
    report.usageAt = usage.value.endTime;
    if (report.usedSeconds === undefined) report.warnings.push("Monthly usage was not returned by Cloud Monitoring API.");
  } else {
    report.warnings.push(`Cloud Monitoring API: ${usage.reason instanceof Error ? usage.reason.message : String(usage.reason)}`);
  }
  return report;
}

async function query(options: Options): Promise<Report[]> {
  const projects = resolveProjects(options);
  const token = options.noLive ? undefined : await getEarthEngineAccessToken();
  return Promise.all(projects.map((project) => queryOne(project, token, options)));
}

function toUnit(seconds: number, unit: EeQuotaUnit): number {
  return unit === "h" ? seconds / 3600 : seconds;
}

function displayUsed(seconds: number, unit: EeQuotaUnit): string {
  return toUnit(seconds, unit).toFixed(1);
}

function displayLimit(seconds: number, unit: EeQuotaUnit): string {
  return toUnit(seconds, unit).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function bar(usedPercent: number, width = 12): string {
  const filled = Math.round((usedPercent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function render(reports: Report[], unit: EeQuotaUnit, showTime = false): string {
  const rows = reports.map((report) => ({
    report,
    percent: report.limitSeconds && report.usedSeconds !== undefined
      ? Math.max(0, Math.min(100, report.usedSeconds / report.limitSeconds * 100))
      : undefined,
    used: report.usedSeconds === undefined ? undefined : displayUsed(report.usedSeconds, unit),
    limit: report.limitSeconds === undefined ? undefined : displayLimit(report.limitSeconds, unit),
  }));
  const w = Math.max(0, ...reports.map((report) => report.project.length));
  const usedW = Math.max(6, ...rows.map((row) => row.used?.length ?? 0));
  const limitW = Math.max(0, ...rows.map((row) => row.limit?.length ?? 0));
  const lines = showTime ? [new Date().toLocaleString("sv-SE", { hour12: false })] : [];
  for (const row of rows) {
    const amount = row.used !== undefined && row.limit !== undefined
      ? `${row.used.padStart(usedW)}/${row.limit.padStart(limitW)} ${unit}`
      : "unavailable";
    lines.push(row.percent === undefined
      ? `${row.report.project.padEnd(w)}  unavailable`
      : `${row.report.project.padEnd(w)}  ${bar(row.percent)} ${row.percent.toFixed(2).padStart(5)}% ${amount}`);
    for (const warning of row.report.warnings) lines.push(`${"".padEnd(w)}  note    ${warning}`);
  }
  return lines.join("\n");
}

function auth(args: string[]): void {
  const cmd = args[0];
  if (cmd === "list" || cmd === undefined) {
    const names = listEeProjects();
    if (!names.length) {
      process.stdout.write("ee-quota: no projects. Run `ee-quota auth enable <PROJECT>`\n");
      return;
    }
    const w = Math.max(7, ...names.map((name) => name.length));
    process.stdout.write(`${"PROJECT".padEnd(w)}  STATUS\n`);
    for (const name of names) {
      process.stdout.write(`${name.padEnd(w)}  ${isEeProjectEnabled(name) ? "enabled" : "disabled"}\n`);
    }
    process.stdout.write(`\nconfig: ${earthEngineConfigPath()}\n`);
    return;
  }
  if (cmd === "enable" || cmd === "disable") {
    const name = args[1]?.trim();
    if (!name) throw new Error(`auth ${cmd} requires a project id`);
    setEeProjectEnabled(name, cmd === "enable");
    process.stdout.write(`ee-quota: ${cmd}d ${name}\n`);
    return;
  }
  throw new Error("usage: ee-quota auth list | enable <PROJECT> | disable <PROJECT>");
}

function config(args: string[]): void {
  if (args[0] === "set") {
    const name = args[1];
    const value = args[2]?.trim();
    if (name === "unit" && (value === "s" || value === "h")) {
      setEeQuotaUnit(value);
      process.stdout.write(`ee-quota: unit set to ${value}\n`);
      return;
    }
    throw new Error("usage: ee-quota config set unit <s|h>");
  }
  const i = args.indexOf("--unit");
  if (i >= 0) {
    const unit = args[i + 1]?.toLowerCase();
    if (unit !== "s" && unit !== "h") throw new Error("ee-quota config --unit requires s or h");
    setEeQuotaUnit(unit);
    process.stdout.write(`ee-quota: unit set to ${unit}\n`);
    return;
  }
  process.stdout.write(`projects: ${enabledEeProjects().join(", ") || "-"}\nunit: ${getEeQuotaUnit()}\n`);
}

function intervalMs(raw: string): number {
  const match = /^(\d+)\s*(s|m)?$/.exec(raw.trim());
  if (!match) throw new Error("--interval must be a positive number (e.g. 30, 30s, 1m)");
  const value = Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
  if (value < 1_000) throw new Error("--interval must be >= 1s");
  return value;
}

function formatInterval(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function parseArgs(args: string[]): Options {
  const out: Options = { noLive: false, watch: false, intervalMs: 60_000, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--project") {
      const raw = args[++i];
      if (!raw || raw.startsWith("-")) throw new Error("-p requires a project id");
      out.projects = [...(out.projects ?? []), ...raw.split(",").map((s) => s.trim()).filter(Boolean)];
    } else if (arg === "--minutes") out.minutes = Number(args[++i]);
    else if (arg === "--unit") {
      const unit = args[++i]?.toLowerCase();
      if (unit !== "s" && unit !== "h") throw new Error("--unit requires s or h");
      out.unit = unit;
    } else if (arg === "--no-live") out.noLive = true;
    else if (arg === "-w" || arg === "--watch") out.watch = true;
    else if (arg === "-i" || arg === "--interval") {
      out.intervalMs = intervalMs(args[++i] ?? "");
      out.watch = true;
    } else if (arg === "--json") out.json = true;
    else throw new Error(`unknown ee-quota option: ${arg}`);
  }
  if (out.minutes !== undefined && (!Number.isInteger(out.minutes) || out.minutes < 1)) {
    throw new Error("--minutes must be a positive integer");
  }
  return out;
}

async function runWatch(options: Options, unit: EeQuotaUnit): Promise<void> {
  const isTty = !!process.stdout.isTTY;
  let lines = 0;
  const hint = `watch · refresh every ${formatInterval(options.intervalMs)} · Ctrl+C to stop`;
  const tick = async () => {
    const out = `${hint}\n${render(await query(options), unit, true)}\n`;
    if (isTty && lines > 0) process.stdout.write(`\x1b[${lines}A\x1b[J`);
    process.stdout.write(out);
    lines = out.split("\n").length - 1;
  };
  process.on("SIGINT", () => process.exit(0));
  await tick();
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    await tick();
  }
}

export async function handleEeQuotaSubcommand(args: string[]): Promise<void> {
  if (args[0] === "auth") {
    auth(args.slice(1));
    return;
  }
  if (args[0] === "config") {
    config(args.slice(1));
    return;
  }
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(EE_QUOTA_HELP);
    return;
  }
  const options = parseArgs(args);
  const unit = options.unit ?? getEeQuotaUnit();
  if (options.watch) {
    await runWatch(options, unit);
    return;
  }
  const reports = await query(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports.map((report) => ({
      ...report,
      unit,
      usedPercent: report.limitSeconds && report.usedSeconds !== undefined
        ? report.usedSeconds / report.limitSeconds * 100
        : undefined,
    })), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(reports, unit)}\n`);
}
