import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { queryQuota } from "./api";
import type { Provider, ProviderSnapshot, QuotaPeriod, QuotaWindow } from "./types";

const LABELS: Record<Provider, string> = {
  minimax: "MiniMax",
  openai: "OpenAI Codex",
  claude: "Claude",
  opencode: "OpenCode Go",
  "deepseek-api": "DeepSeek",
  grok: "Grok",
  kimi: "Kimi",
  zhipu: "智谱 GLM",
};
const MARKS: Record<Provider, { mark: string; tone: string }> = {
  minimax: { mark: "M", tone: "violet" },
  openai: { mark: "◎", tone: "green" },
  claude: { mark: "✦", tone: "orange" },
  opencode: { mark: "⌘", tone: "blue" },
  "deepseek-api": { mark: "D", tone: "indigo" },
  grok: { mark: "𝕏", tone: "slate" },
  kimi: { mark: "K", tone: "cyan" },
  zhipu: { mark: "Z", tone: "rose" },
};
const PERIODS: Record<QuotaPeriod, string> = { short: "短周期", daily: "日", weekly: "周", monthly: "月" };
const PERIOD_SHORT: Record<QuotaPeriod, string> = { short: "短", daily: "日", weekly: "周", monthly: "月" };
interface Config {
  target: string;
  refreshSeconds: number;
  refreshLimit: number;
  quietStart: number;
  quietEnd: number;
  paused: boolean;
}

interface Target {
  id: string;
  provider: Provider;
  label: string;
  text: string;
  tone: "safe" | "warn" | "danger" | "balance";
  tooltip: string;
}

function positive(n: unknown, fallback: number) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function hour(n: unknown, fallback: number) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(23, Math.max(0, Math.floor(v))) : fallback;
}

/** start===end 关闭；23–8 跨日 */
function inQuiet(start: number, end: number, h = new Date().getHours()) {
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

function loadConfig(): Config {
  try {
    const saved = JSON.parse(localStorage.getItem("ai-quota.desktop") ?? "{}") as Partial<Config>;
    return {
      target: saved.target ?? "",
      refreshSeconds: positive(saved.refreshSeconds, 120),
      refreshLimit: positive(saved.refreshLimit, 30),
      quietStart: hour(saved.quietStart, 23),
      quietEnd: hour(saved.quietEnd, 8),
      paused: saved.paused ?? false,
    };
  } catch {
    return { target: "", refreshSeconds: 120, refreshLimit: 30, quietStart: 23, quietEnd: 8, paused: false };
  }
}

function used(window: QuotaWindow): number {
  return Math.round(Math.max(0, Math.min(100, Number.isFinite(window.remainingPercent)
    ? 100 - window.remainingPercent
    : window.usedPercent)));
}

function tone(percent: number): Target["tone"] {
  return percent < 50 ? "safe" : percent < 80 ? "warn" : "danger";
}

function targetsOf(providers: ProviderSnapshot[]): Target[] {
  const targets: Target[] = [];
  for (const provider of providers) {
    if (provider.status !== "ok") continue;
    for (const model of provider.models) {
      const base = `${LABELS[provider.provider]} · ${model.name}`;
      if (model.balance) {
        const amount = model.balance.amount.toFixed(1);
        targets.push({
          id: targetId(provider.provider, model.name, "balance"),
          provider: provider.provider,
          label: `${base} · 余额`,
          text: `￥${amount}`,
          tone: "balance",
          tooltip: `${base}：￥${amount}`,
        });
      }
      for (const [period, window] of Object.entries(model.windows) as [QuotaPeriod, QuotaWindow][]) {
        const percent = used(window);
        targets.push({
          id: targetId(provider.provider, model.name, period),
          provider: provider.provider,
          label: `${base} · ${PERIODS[period]}`,
          text: `${percent}%`,
          tone: tone(percent),
          tooltip: `${base} · ${PERIODS[period]}：${percent}% 已用`,
        });
      }
    }
  }
  return targets;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingTime(iso: string): string {
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "到期";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

function targetId(provider: Provider, model: string, key: string) {
  return JSON.stringify([provider, model, key]);
}

function ProviderCard({
  data, selectedId, onSelect,
}: {
  data: ProviderSnapshot;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const meta = MARKS[data.provider];
  return (
    <article className="provider-card">
      <header className="provider-head">
        <span className={`provider-mark ${meta.tone}`}>{meta.mark}</span>
        <strong>{LABELS[data.provider]}</strong>
      </header>
      {data.status === "error" ? <p className="provider-error">{data.error.message}</p> : data.models.map((model) => {
        const windows = Object.entries(model.windows) as [QuotaPeriod, QuotaWindow][];
        const balanceId = targetId(data.provider, model.name, "balance");
        return (
          <section className="model" key={model.name}>
            {(data.models.length > 1 || windows.length > 0) && (
              <div className="model-name">
                <span>{model.name}</span>
                {model.balance && windows.length > 0 && <b>￥{model.balance.amount.toFixed(1)}</b>}
              </div>
            )}
            {model.balance && windows.length === 0 && (
              <button type="button" className={`quota-row is-balance${balanceId === selectedId ? " is-selected" : ""}`} onClick={() => onSelect(balanceId)} title="设为托盘显示">
                <span>余额</span>
                <strong className="balance">￥{model.balance.amount.toFixed(1)}</strong>
              </button>
            )}
            {windows.map(([period, window]) => {
              const percent = used(window);
              const id = targetId(data.provider, model.name, period);
              return (
                <button type="button" className={`quota-row${id === selectedId ? " is-selected" : ""}`} key={period} onClick={() => onSelect(id)} title="设为托盘显示">
                  <span>{PERIOD_SHORT[period]}</span>
                  <div className={`progress ${tone(percent)}`} aria-hidden><i style={{ width: `${percent}%` }} /></div>
                  <strong className={tone(percent)}>{percent}%</strong>
                  <small>{remainingTime(window.resetsAt)}</small>
                </button>
              );
            })}
          </section>
        );
      })}
    </article>
  );
}

export default function App() {
  const [config, setConfig] = useState(loadConfig);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<number>();
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");

  const refreshAll = useCallback(async () => {
    setError("");
    try {
      const snapshot = await queryQuota();
      setProviders(snapshot.providers);
      setRefreshedAt(Date.parse(snapshot.generatedAt));
    } catch (cause) {
      setError(`${message(cause)}（详见 EXE 同目录 log.txt）`);
    } finally {
      setInitializing(false);
    }
  }, []);

  const targets = useMemo(() => targetsOf(providers), [providers]);
  const selected = targets.find((target) => target.id === config.target) ?? targets[0];

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    void invoke("set_tray_display", {
      text: selected?.text.replace("%", "") ?? "--",
      tone: selected?.tone ?? "idle",
      tooltip: selected?.tooltip ?? "AI Quota：等待额度数据",
    });
  }, [selected]);

  useEffect(() => {
    localStorage.setItem("ai-quota.desktop", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    const subscription = listen("tray-refresh-all", () => void refreshAll());
    return () => { void subscription.then((unlisten) => unlisten()); };
  }, [refreshAll]);

  const leftRef = useRef(config.refreshLimit);
  const [autoLeft, setAutoLeft] = useState(config.refreshLimit);
  const [now, setNow] = useState(() => Date.now());
  const silent = inQuiet(config.quietStart, config.quietEnd, new Date(now).getHours());

  useEffect(() => {
    if (config.paused || !config.refreshSeconds) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (inQuiet(config.quietStart, config.quietEnd)) return;
      void refreshAll();
      leftRef.current -= 1;
      setAutoLeft(leftRef.current);
      if (leftRef.current <= 0) setConfig((c) => ({ ...c, paused: true }));
    }, config.refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [config.paused, config.refreshSeconds, config.quietStart, config.quietEnd, refreshAll]);

  return (
    <main>
      <header className="app-header">
        <div><span className="brand">Q</span><div><strong>AI Quota</strong><small>{config.paused ? "已暂停" : silent ? "静默中" : refreshedAt ? `更新 ${new Date(refreshedAt).toLocaleTimeString("zh-CN", { hour12: false })} · 剩 ${autoLeft}` : "本地查询"}</small></div></div>
        <div className="header-actions">
          <button className="pause" onClick={() => {
            const next = !config.paused;
            if (next === false) {
              leftRef.current = config.refreshLimit;
              setAutoLeft(config.refreshLimit);
            }
            setConfig({ ...config, paused: next });
          }}>{config.paused ? "继续" : "暂停"}</button>
          <button className="refresh" onClick={() => void refreshAll()}>刷新全部</button>
          <button className="close" onClick={() => void invoke("hide_window")} aria-label="关闭">×</button>
        </div>
      </header>

      <section className="controls">
        <label>
          <span>托盘显示</span>
          <select value={targets.some((target) => target.id === config.target) ? config.target : ""} onChange={(event) => setConfig({ ...config, target: event.target.value })}>
            <option value="">首个可用额度</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
          </select>
        </label>
        <label className="interval">
          <span>间隔</span>
          <div><input type="number" min={1} value={config.refreshSeconds} onChange={(event) => setConfig({ ...config, refreshSeconds: Number(event.target.value) })} /><small>s</small></div>
        </label>
        <label className="interval">
          <span>次数</span>
          <div><input type="number" min={1} value={config.refreshLimit} onChange={(event) => {
            const refreshLimit = Number(event.target.value);
            leftRef.current = refreshLimit;
            setAutoLeft(refreshLimit);
            setConfig({ ...config, refreshLimit });
          }} /><small>次</small></div>
        </label>
        <label className="quiet">
          <span>静默时段</span>
          <div>
            <input type="number" min={0} max={23} value={config.quietStart} onChange={(event) => setConfig({ ...config, quietStart: hour(event.target.value, 23) })} />
            <i>–</i>
            <input type="number" min={0} max={23} value={config.quietEnd} onChange={(event) => setConfig({ ...config, quietEnd: hour(event.target.value, 8) })} />
          </div>
        </label>
      </section>

      <section className="quota-list">
        <h2>全部模型 <small>{providers.length ? `${providers.length} Provider` : initializing ? "加载中" : "无数据"}{config.paused && " · 已暂停"}</small></h2>
        {providers.length ? providers.map((provider) => (
          <ProviderCard key={provider.provider} data={provider} selectedId={selected?.id} onSelect={(id) => setConfig({ ...config, target: id })} />
        )) : <p className="empty">{initializing ? "正在读取本地凭据并查询额度…" : "未找到可用额度数据。"}</p>}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
