import type { ModelRemain } from "./provider/minimax.js";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const useColor =
  !!process.env.FORCE_COLOR ||
  (!process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY);
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c(2);
const green = c(32), yellow = c(33), red = c(31), cyan = c(36);

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  if (d > 0) return `${d}d ${String(h).padStart(2)}h ${String(m).padStart(2)}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2)}m`;
  return `${m}m`;
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
  get: (m: ModelRemain) => { remaining: number; endTime: number };
}

const COLS: [Col, Col] = [
  { get: (m) => ({ remaining: m.interval.remaining_percent, endTime: m.interval.end_time }) },
  { get: (m) => ({ remaining: m.weekly.remaining_percent, endTime: m.weekly.end_time }) },
];

export function displayName(name: string): string {
  if (name === "general" || name === "MiniMax") return "minimax";
  if (name === "video" || name === "MiniMax-video") return "minimax video";
  return name;
}

function modelRank(name: string): number {
  const shown = displayName(name);
  if (shown.startsWith("claude")) return 0;
  if (shown.startsWith("codex")) return 1;
  if (shown.startsWith("minimax")) return 2;
  if (shown.startsWith("opencode")) return 3;
  if (shown.startsWith("deepseek")) return 99;
  return 5;
}

function money(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const symbol = code === "CNY" ? "¥" : code === "USD" ? "$" : `${code} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function renderCell(col: Col, m: ModelRemain, now: number, durWidth: number): string {
  const { remaining, endTime } = col.get(m);
  const used = 100 - remaining;
  const color = colorFor(remaining);
  const b = color(bar(remaining));
  const pct = `${used.toFixed(0).padStart(3)}%`;
  const inMs = endTime - now;
  return `${b} ${color(pct)}  ${cyan(fmtDuration(inMs).padStart(durWidth))}`;
}

/** 去掉 ANSI 转义码以计算显示宽度 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const padVisible = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - stripAnsi(s).length));

export function renderReport(
  items: ModelRemain[],
  now = Date.now(),
  _title = "MiniMax Coding Plan",
  filter?: (displayName: string) => boolean,
): string {
  if (items.length === 0) return dim("no quota data");
  const visible = filter ? items.filter((m) => filter(displayName(m.model_name))) : items;
  if (visible.length === 0) return dim("no quota data");
  const sorted = [...visible].sort((a, b) => {
    const byRank = modelRank(a.model_name) - modelRank(b.model_name);
    return byRank || displayName(a.model_name).localeCompare(displayName(b.model_name));
  });

  // 先求每列 duration 的最大显示宽度（让短 duration 右对齐到该宽度）
  const durWidths = COLS.map((col) =>
    Math.max(...sorted.map((m) => fmtDuration(col.get(m).endTime - now).length)),
  );

  // 预渲染所有单元格，按列取最大显示宽度
  const cells = sorted.map((m) =>
    COLS.map((col, i) => renderCell(col, m, now, durWidths[i] ?? 0)),
  );
  const colWidths = COLS.map((_, i) => Math.max(...cells.map((row) => stripAnsi(row[i] ?? "").length)));
  const lines: string[] = [fmtTime(now)];

  sorted.forEach((m, r) => {
    const first = padVisible(cells[r]?.[0] ?? "", colWidths[0] ?? 0);
    const tail = m.balance
      ? ` ${money(m.balance.amount, m.balance.currency)}`
      : (cells[r] ?? []).slice(1).map((cell, i) => ` ${padVisible(cell, colWidths[i + 1] ?? 0)}`).join("");
    const row =
      "  " +
      displayName(m.model_name).padEnd(14) +
      first +
      tail;
    lines.push(row);
  });

  return lines.join("\n");
}
