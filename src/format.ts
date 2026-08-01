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
  // round（非 ceil）：0% 已用必须 0 格；ceil 会把 0.1% 也撑成 1 格
  const filled = Math.max(0, Math.min(w, Math.round(((100 - remaining) / 100) * w)));
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

const COLS_TWO: Col[] = [
  { get: (m) => ({ remaining: m.interval.remaining_percent, endTime: m.interval.end_time }) },
  { get: (m) => ({ remaining: m.weekly.remaining_percent, endTime: m.weekly.end_time }) },
];

const COLS_OPENCODE_THREE: Col[] = [
  { get: (m) => ({ remaining: m.interval.remaining_percent, endTime: m.interval.end_time }) },
  { get: (m) => ({ remaining: m.weekly.remaining_percent, endTime: m.weekly.end_time }) },
  {
    get: (m) => ({
      remaining: m.monthly?.remaining_percent ?? 0,
      endTime: m.monthly?.end_time ?? 0,
    }),
  },
];

function isOpencodeThreeCol(m: ModelRemain): boolean {
  return displayName(m.model_name).startsWith("opencode") && m.monthly !== undefined;
}

function colsForModel(m: ModelRemain): Col[] {
  return isOpencodeThreeCol(m) ? COLS_OPENCODE_THREE : COLS_TWO;
}

function maxCols(items: ModelRemain[]): number {
  return items.some(isOpencodeThreeCol) ? 3 : 2;
}

export function displayName(name: string): string {
  if (name === "general" || name === "MiniMax") return "minimax";
  if (name === "video" || name === "MiniMax-video") return "minimax-video";
  return name.replace(/\s*·\s*/g, "·");
}

function modelRank(name: string): number {
  const shown = displayName(name);
  if (shown.startsWith("claude")) return 0;
  if (shown.startsWith("codex")) return 1;
  if (shown.startsWith("grok")) return 2;
  if (shown.startsWith("opencode")) return 3;
  if (shown.startsWith("minimax")) return 4;
  if (shown.startsWith("kimi")) return 5;
  if (shown.startsWith("zhipu")) return 6;
  if (shown.startsWith("deepseek")) return 99;
  return 7;
}

function money(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const symbol = code === "CNY" ? "¥" : code === "USD" ? "$" : `${code} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function renderCell(
  col: Col,
  m: ModelRemain,
  now: number,
  durWidth: number,
  pctWidth: number,
  barWidth = 10,
): string {
  const { remaining, endTime } = col.get(m);
  const { bar, pct, dur } = cellBody(remaining, endTime, now, barWidth, pctWidth);
  return `${bar} ${pct} ${padVisibleStart(dur, durWidth)}`;
}

/** 单元格三件套（bar / pct / dur），给 wide 和 compact 两种布局共享。 */
function cellBody(remaining: number, endTime: number, now: number, barWidth: number, pctWidth = 3) {
  const used = 100 - remaining;
  const color = colorFor(remaining);
  return {
    bar: color(bar(remaining, barWidth)),
    pct: color(`${used.toFixed(0)}%`.padStart(pctWidth)),
    dur: cyan(fmtDuration(endTime - now)),
  };
}

/** 去掉 ANSI 转义码以计算显示宽度 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const padVisible = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - stripAnsi(s).length));
const padVisibleStart = (s: string, width: number): string =>
  " ".repeat(Math.max(0, width - stripAnsi(s).length)) + s;

export function renderReport(
  items: ModelRemain[],
  now = Date.now(),
  _title = "MiniMax Coding Plan",
  filter?: (displayName: string) => boolean,
  compact?: boolean,
  extras?: Record<string, string>,
): string {
  if (items.length === 0) return dim("no quota data");
  const visible = filter ? items.filter((m) => filter(displayName(m.model_name))) : items;
  if (visible.length === 0) return dim("no quota data");
  const sorted = [...visible].sort((a, b) => {
    const byRank = modelRank(a.model_name) - modelRank(b.model_name);
    return byRank || displayName(a.model_name).localeCompare(displayName(b.model_name));
  });

  const pctWidth = Math.max(
    3,
    ...sorted.flatMap((m) =>
      colsForModel(m).map((col) => `${(100 - col.get(m).remaining).toFixed(0)}%`.length),
    ),
  );

  // 窄屏（手机 / 短 TTY）：每列独立成行，避免被外层终端 wrap 拆开 reset 时间。
  // 未传 compact 时按 stdout.columns 启发判断；显式 --compact/--wide 覆盖之。
  const wantCompact = compact ?? (process.stdout.columns ?? 80) < 60;
  if (wantCompact) return renderReportCompact(sorted, now, pctWidth, extras);

  const nCols = maxCols(sorted);
  const durWidths = Array.from({ length: nCols }, (_, i) =>
    Math.max(
      ...sorted.map((m) => {
        const cols = colsForModel(m);
        const col = cols[i];
        return col ? fmtDuration(col.get(m).endTime - now).length : 0;
      }),
    ),
  );
  const cells = sorted.map((m) => {
    const cols = colsForModel(m);
    return cols.map((col, i) => renderCell(col, m, now, durWidths[i] ?? 0, pctWidth));
  });
  const colWidths = Array.from({ length: nCols }, (_, i) =>
    Math.max(...cells.map((row) => stripAnsi(row[i] ?? "").length)),
  );
  const lines: string[] = [fmtTime(now)];
  const nameWidth = Math.max(...sorted.map((m) => displayName(m.model_name).length)) + 2;

  sorted.forEach((m, r) => {
    const rowCells = cells[r] ?? [];
    const first = padVisible(rowCells[0] ?? "", colWidths[0] ?? 0);
    const tail = m.balance
      ? ` ${money(m.balance.amount, m.balance.currency)}`
      : rowCells.slice(1).map((cell, i) => ` ${padVisible(cell, colWidths[i + 1] ?? 0)}`).join("");
    const row =
      "  " +
      displayName(m.model_name).padEnd(nameWidth) +
      first +
      tail;
    lines.push(row);
  });

  return lines.join("\n");
}

/** 窄屏竖排版：每 provider 一组多行（name + 5h + week + 月度可选 + balance 可选），避免外层 wrap。 */
function renderReportCompact(
  sorted: ModelRemain[],
  now: number,
  pctWidth: number,
  extras?: Record<string, string>,
): string {
  const lines: string[] = [fmtTime(now)];
  const labels = ["5h", "wk", "mo"];
  for (const m of sorted) {
    lines.push(displayName(m.model_name));
    const cols = colsForModel(m);
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      if (!col) continue;
      const { remaining, endTime } = col.get(m);
      const { bar, pct, dur } = cellBody(remaining, endTime, now, 8, pctWidth);
      lines.push(`  ${labels[i]!.padEnd(3)} ${bar} ${pct}  ${dur}`);
    }
    if (m.balance) lines.push(`  bal ${money(m.balance.amount, m.balance.currency)}`);
    const extra = findExtra(extras, m.model_name);
    if (extra) for (const line of extra.split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/** extras key 按 model_name 前缀匹配（"codex" 匹配 "codex · pro" / "codex · max"）；无匹配返回 undefined。 */
function findExtra(extras: Record<string, string> | undefined, modelName: string): string | undefined {
  return Object.entries(extras ?? {}).find(([k]) => modelName.startsWith(k))?.[1];
}
