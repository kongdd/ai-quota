import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configureMonitor, getMonitor, loadConfig, queryQuota, startMonitor, type Config, type MonitorState } from "./api";
import { LABELS, PERIOD_SHORT, targetId, targetsOf, tone, used, visibleModels, visibleWindows } from "./display";
import { PROVIDERS, type Provider, type ProviderSnapshot } from "./types";

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

function hour(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(23, Math.max(0, Math.floor(value))) : fallback;
}

function count(raw: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > max) return undefined;
  return Math.floor(value);
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

function ProviderCard({
  data, refreshing, selectedId, onRefresh, onSelect,
}: {
  data: ProviderSnapshot;
  refreshing: boolean;
  selectedId?: string;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  const meta = MARKS[data.provider];
  const models = visibleModels(data);
  const singleModel = models.length === 1 ? models[0] : undefined;
  const headerBalance = singleModel?.balance && Object.keys(singleModel.windows).length
    ? `￥${singleModel.balance.amount.toFixed(1)}`
    : undefined;
  return (
    <article className="provider-card">
      <header className="provider-head">
        <span className={`provider-mark ${meta.tone}`}>{meta.mark}</span>
        <strong>{LABELS[data.provider]}</strong>
        {headerBalance && <b className="provider-balance">{headerBalance}</b>}
        <button type="button" className="provider-refresh" onClick={onRefresh} disabled={refreshing} aria-label={`刷新 ${LABELS[data.provider]}`} title="刷新">
          {refreshing ? "…" : "↻"}
        </button>
      </header>
      {data.status === "error" ? <p className="provider-error">{data.error.message}</p> : models.map((model) => {
        const windows = visibleWindows(data.provider, model.windows);
        const balanceId = targetId(data.provider, model.name, "balance");
        return (
          <section className="model" key={model.name}>
            {models.length > 1 && (
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
                  <strong className={tone(percent)}>{percent.toFixed(1)}%</strong>
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
  const [config, updateConfig] = useState(loadConfig);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<number>();
  const [initializing, setInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState<Provider[]>([]);
  const [error, setError] = useState("");
  const [autoLeft, setAutoLeft] = useState(config.refreshLimit);
  const [silent, setSilent] = useState(false);
  const revision = useRef(0);

  const apply = useCallback((state: MonitorState) => {
    if (state.revision < revision.current) return;
    revision.current = state.revision;
    localStorage.removeItem("ai-quota.desktop");
    updateConfig(state.config);
    setAutoLeft(state.autoLeft);
    setSilent(state.silent);
    setError(state.error);
    if (state.snapshot) {
      setProviders(state.snapshot.providers);
      setRefreshedAt(Date.parse(state.snapshot.generatedAt));
    }
    if (state.snapshot || state.error) setInitializing(false);
  }, []);

  const setConfig = (next: Config) => {
    void configureMonitor(next).then(apply).catch((cause) => setError(message(cause)));
  };

  const refreshAll = useCallback(async () => {
    try {
      apply(await queryQuota());
    } catch (cause) {
      setError(message(cause));
      setInitializing(false);
    }
  }, [apply]);

  const refreshProvider = useCallback(async (provider: Provider) => {
    setRefreshing((current) => [...current, provider]);
    try {
      apply(await queryQuota(provider));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setRefreshing((current) => current.filter((item) => item !== provider));
    }
  }, [apply]);

  const orderedProviders = PROVIDERS.flatMap((provider) =>
    providers.filter((item) => item.provider === provider),
  );
  const targets = useMemo(() => targetsOf(providers), [providers]);
  const selected = targets.find((target) => target.id === config.target) ?? targets[0];

  useEffect(() => {
    let disposed = false;
    const sync = (state: MonitorState) => { if (!disposed) apply(state); };
    const subscriptions = Promise.all([
      listen<MonitorState>("monitor-updated", (event) => sync(event.payload)),
      listen("tauri://focus", () => { void getMonitor().then(sync); }),
    ]);
    void subscriptions.then(() => startMonitor(loadConfig())).then(sync)
      .catch((cause) => { if (!disposed) setError(message(cause)); });
    return () => {
      disposed = true;
      void subscriptions.then((listeners) => listeners.forEach((unlisten) => unlisten()));
    };
  }, [apply]);
  return (
    <main>
      <header className="app-header">
        <div><span className="brand">Q</span><div><strong>AI Quota</strong><small>{config.paused ? "已暂停" : silent ? "静默中" : refreshedAt ? `更新 ${new Date(refreshedAt).toLocaleTimeString("zh-CN", { hour12: false })} · 剩 ${autoLeft}` : "本地查询"}</small></div></div>
        <div className="header-actions">
          <button className="pause" onClick={() => setConfig({ ...config, paused: !config.paused })}>{config.paused ? "继续" : "暂停"}</button>
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
          <div><input type="number" min={1} value={config.refreshSeconds} onChange={(event) => {
            const refreshSeconds = count(event.target.value, 86400);
            if (refreshSeconds) setConfig({ ...config, refreshSeconds });
          }} /><small>s</small></div>
        </label>
        <label className="interval">
          <span>次数</span>
          <div><input type="number" min={1} value={config.refreshLimit} onChange={(event) => {
            const refreshLimit = count(event.target.value);
            if (refreshLimit) setConfig({ ...config, refreshLimit });
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
        <h2>全部模型 <small>{initializing ? "查询中" : `${providers.length} Provider`}{config.paused && " · 已暂停"}</small></h2>
        {orderedProviders.map((provider) => (
          <ProviderCard
            key={provider.provider}
            data={provider}
            refreshing={refreshing.includes(provider.provider)}
            selectedId={selected?.id}
            onRefresh={() => void refreshProvider(provider.provider)}
            onSelect={(id) => setConfig({ ...config, target: id })}
          />
        ))}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
