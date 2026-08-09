import process from "node:process";
import {
  earthEngineConfigPath,
  earthEngineCredentialsPath,
  getEarthEngineAccessToken,
  getEeQuotaProject,
  getEeQuotaUnit,
  setEeQuotaProject,
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
  --minutes <N>        Usage lookback window (default: 60)
  --unit <s|h>         Display seconds or hours (default: configured s)
  --no-live             Skip live quota and usage lookup
  -w, --watch           Refresh in place until Ctrl+C
  -i, --interval <N>    Refresh interval (30, 30s, 1m; implies --watch)
  --json                Print the normalized result as JSON
  -h, --help            Show this help

Commands:
  ee-quota config set project <ID>
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
  minutes: number;
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

async function resolveProject(): Promise<string> {
  const project = getEeQuotaProject();
  if (!project) throw new Error(`Earth Engine project is missing in ${earthEngineCredentialsPath()}`);
  return project;
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

async function fetchUsage(project: string, token: string, minutes: number): Promise<{ value?: number; endTime?: string }> {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
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

async function query(options: Options): Promise<Report> {
  const project = await resolveProject();
  const report: Report = { project, warnings: [] };
  if (options.noLive) {
    report.warnings.push("Live quota lookup skipped because --no-live was set.");
    return report;
  }

  const token = await getEarthEngineAccessToken();
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

function displayValue(seconds: number, unit: EeQuotaUnit): string {
  const value = unit === "h" ? seconds / 3600 : seconds;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function bar(usedPercent: number, width = 12): string {
  const filled = Math.round((usedPercent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function render(report: Report, unit: EeQuotaUnit, showTime = false): string {
  const percent = report.limitSeconds && report.usedSeconds !== undefined
    ? Math.max(0, Math.min(100, report.usedSeconds / report.limitSeconds * 100))
    : undefined;
  const amount = report.usedSeconds !== undefined && report.limitSeconds !== undefined
    ? `${displayValue(report.usedSeconds, unit)}/${displayValue(report.limitSeconds, unit)} ${unit}`
    : "unavailable";
  const lines = [
    ...(showTime ? [new Date().toLocaleString("sv-SE", { hour12: false })] : []),
    percent === undefined ? "  unavailable" : `  ${bar(percent)} ${percent.toFixed(2)}%   ${amount}`,
  ];
  for (const warning of report.warnings) lines.push(`  note    ${warning}`);
  return lines.join("\n");
}

function config(args: string[]): void {
  if (args[0] === "set") {
    const name = args[1];
    const value = args[2]?.trim();
    if (name === "project" && value) {
      setEeQuotaProject(value);
      process.stdout.write(`ee-quota: project set to ${value}\n`);
      return;
    }
    if (name === "unit" && (value === "s" || value === "h")) {
      setEeQuotaUnit(value);
      process.stdout.write(`ee-quota: unit set to ${value}\n`);
      return;
    }
    throw new Error("usage: ee-quota config set project <ID> | unit <s|h>");
  }
  const i = args.indexOf("--unit");
  if (i >= 0) {
    const unit = args[i + 1]?.toLowerCase();
    if (unit !== "s" && unit !== "h") throw new Error("ee-quota config --unit requires s or h");
    setEeQuotaUnit(unit);
    process.stdout.write(`ee-quota: unit set to ${unit}\n`);
    return;
  }
  process.stdout.write(`project: ${getEeQuotaProject() ?? "-"}\nunit: ${getEeQuotaUnit()}\n`);
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
  const out: Options = { minutes: 60, noLive: false, watch: false, intervalMs: 60_000, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--minutes") out.minutes = Number(args[++i]);
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
  if (!Number.isInteger(out.minutes) || out.minutes < 1) throw new Error("--minutes must be a positive integer");
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
  const report = await query(options);
  if (options.json) {
    const percent = report.limitSeconds && report.usedSeconds !== undefined
      ? report.usedSeconds / report.limitSeconds * 100
      : undefined;
    process.stdout.write(`${JSON.stringify({ ...report, unit, usedPercent: percent }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(report, unit)}\n`);
}
