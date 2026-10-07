import { PROVIDERS, type Provider, type ProviderSnapshot, type QuotaPeriod, type QuotaWindow } from "./types.ts";

export const LABELS: Record<Provider, string> = {
  minimax: "MiniMax",
  openai: "OpenAI",
  claude: "Claude",
  opencode: "OpenCode Go",
  "deepseek-api": "DeepSeek",
  grok: "Grok",
  kimi: "Kimi",
  zhipu: "智谱 GLM",
};

const PERIODS: Record<QuotaPeriod, string> = { short: "短周期", daily: "日", weekly: "周", monthly: "月" };
export const PERIOD_SHORT: Record<QuotaPeriod, string> = { short: "短", daily: "日", weekly: "周", monthly: "月" };

export interface Target {
  id: string;
  provider: Provider;
  label: string;
  text: string;
  tone: "safe" | "warn" | "danger" | "balance";
  tooltip: string;
}

export function used(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, Number.isFinite(window.remainingPercent)
    ? 100 - window.remainingPercent
    : window.usedPercent));
}

export function tone(percent: number): Target["tone"] {
  return percent < 50 ? "safe" : percent < 80 ? "warn" : "danger";
}

export function visibleWindows(provider: Provider, windows: Partial<Record<QuotaPeriod, QuotaWindow>>) {
  return (Object.entries(windows) as [QuotaPeriod, QuotaWindow][])
    .filter(([period]) => provider !== "deepseek-api" || period !== "monthly");
}

export function visibleModels(provider: ProviderSnapshot) {
  return provider.status === "ok"
    ? provider.models.filter((model) => provider.provider !== "openai" || model.name !== "openai · apps")
    : [];
}

export function targetsOf(providers: ProviderSnapshot[]): Target[] {
  const targets: Target[] = [];
  for (const name of PROVIDERS) {
    const provider = providers.find((item) => item.provider === name);
    if (!provider || provider.status !== "ok") continue;
    const models = visibleModels(provider);
    for (const model of models) {
      const base = `${LABELS[provider.provider]} · ${model.name}`;
      const label = models.length > 1 || provider.provider === "openai" ? base : LABELS[provider.provider];
      if (model.balance) {
        const amount = model.balance.amount.toFixed(1);
        targets.push({
          id: targetId(provider.provider, model.name, "balance"),
          provider: provider.provider,
          label: `${label} 余额`,
          text: `￥${amount}`,
          tone: "balance",
          tooltip: `${base}：￥${amount}`,
        });
      }
      for (const [period, window] of visibleWindows(provider.provider, model.windows)) {
        const percent = used(window);
        targets.push({
          id: targetId(provider.provider, model.name, period),
          provider: provider.provider,
          label: `${label} ${PERIOD_SHORT[period]}`,
          text: `${Math.round(percent)}%`,
          tone: tone(percent),
          tooltip: `${base} · ${PERIODS[period]}：${percent.toFixed(1)}% 已用`,
        });
      }
    }
  }
  return targets;
}

export function targetId(provider: Provider, model: string, key: string) {
  return JSON.stringify([provider, model, key]);
}
