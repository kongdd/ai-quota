export const DESKTOP_QUERY_VALUES = { "timeout-ms": 10_000, retries: 1 } as const;

export interface DesktopProxy {
  all: string | { url: string; noProxy?: string };
}

export function proxyFrom(env: Record<string, string>): DesktopProxy | undefined {
  const url = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy
    ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!url) return undefined;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  return { all: noProxy ? { url, noProxy } : url };
}

export function proxyLabel(proxy: DesktopProxy | undefined): string {
  if (!proxy) return "none";
  const raw = typeof proxy.all === "string" ? proxy.all : proxy.all.url;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "invalid";
  }
}

export function requestLabel(input: URL | Request | string, method?: string): string {
  const verb = method ?? (input instanceof Request ? input.method : "GET");
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return `${verb.toUpperCase()} ${url.origin}${url.pathname}`;
  } catch {
    return `${verb.toUpperCase()} invalid-url`;
  }
}
