import type { ModelRemain } from "./api.js";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const useColor =
  !!process.env.FORCE_COLOR ||
  (!process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY);
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36), magenta = c(35), bold = c(1);

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (d > 0 || h > 0) parts.push(`${String(h).padStart(2)}h`);
  parts.push(`${String(m).padStart(2)}m`);
  return parts.join(" ");
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("sv-SE", { hour12: false });
}

/** 把 0~100 的剩余百分比渲染成进度条（已用 = 100 - remaining） */
function bar(remaining: number, w = 10): string {
  const filled = Math.max(0, Math.min(w, Math.ceil(((100 - remaining) / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** 根据"已用比例"染色（高使用率 = 红） */
function colorFor(remaining: number) {
  const used = 1 - remaining / 100;
  return used < 0.5 ? green : used < 0.8 ? yellow : red;
}

interface Col {
  label: string;
  get: (m: ModelRemain) => { remaining: number; endTime: number };
}

const COLS: [Col, Col] = [
  { label: "5h ", get: (m) => ({ remaining: m.interval.remaining_percent, endTime: m.interval.end_time }) },
  { label: "week", get: (m) => ({ remaining: m.weekly.remaining_percent, endTime: m.weekly.end_time }) },
];

function renderCell(col: Col, m: ModelRemain, now: number): string {
  const { remaining, endTime } = col.get(m);
  const used = 100 - remaining;
  const color = colorFor(remaining);
  const b = color(bar(remaining));
  const pct = `${used.toFixed(0)}%`.padStart(3);
  const inMs = endTime - now;
  return `${b} ${color(pct)} ${cyan(fmtDuration(inMs))}`;
}

/** 去掉 ANSI 转义码以计算显示宽度 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

export function renderReport(items: ModelRemain[], now = Date.now()): string {
  if (items.length === 0) return dim("no quota data");
  const sorted = [...items].sort((a, b) => a.model_name.localeCompare(b.model_name));

  // 预渲染所有单元格，按列取最大显示宽度
  const cells = sorted.map((m) => COLS.map((col) => renderCell(col, m, now)));
  const colWidths = COLS.map((col, i) =>
    Math.max(col.label.length, ...cells.map((row) => stripAnsi(row[i] ?? "").length)),
  );

  const header =
    "  " +
    bold("Model").padEnd(14) +
    " " +
    COLS.map((col, i) => bold(col.label).padEnd(colWidths[i] ?? col.label.length)).join(" ");

  const lines: string[] = [
    bold(magenta("MiniMax Coding Plan")) + dim(` · ${fmtTime(now)}`),
    "",
    cyan(bold("── usage ──")),
    header,
  ];

  sorted.forEach((m, r) => {
    const row =
      "  " +
      m.model_name.padEnd(14) +
      " " +
      (cells[r] ?? []).map((cell, i) => cell.padEnd(colWidths[i] ?? 0)).join(" ");
    lines.push(row);
  });

  return lines.join("\n");
}
