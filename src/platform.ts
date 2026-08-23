export interface PlatformRuntime {
  env: Record<string, string | undefined>;
  platform: string;
  home: string;
  fetch: typeof globalThis.fetch;
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, contents: string): void;
  mkdir(path: string): void;
  copy(source: string, destination: string): void;
  join(...parts: string[]): string;
  dirname(path: string): string;
  randomUUID(): string;
}

const clean = (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/");
const browserRuntime: PlatformRuntime = {
  env: {},
  platform: "browser",
  home: "/",
  fetch: (...args) => globalThis.fetch(...args),
  exists: () => false,
  read: (path) => { throw new Error(`read ${path} failed`); },
  write: (path) => { throw new Error(`write ${path} failed`); },
  mkdir: () => {},
  copy: () => {},
  join: (...parts) => clean(parts.filter(Boolean).join("/")),
  dirname: (path) => clean(path).replace(/\/[^/]*$/, "") || "/",
  randomUUID: () => globalThis.crypto.randomUUID(),
};

let runtime = browserRuntime;

export function configurePlatform(next: PlatformRuntime): PlatformRuntime {
  const previous = runtime;
  runtime = next;
  return previous;
}

export const env = new Proxy({} as Record<string, string | undefined>, {
  get: (_, key) => runtime.env[String(key)],
});
export const fetchQuota: typeof globalThis.fetch = (...args) => runtime.fetch(...args);
export const existsSync = (path: string) => runtime.exists(path);
export const readFileSync = (path: string, _encoding = "utf8") => runtime.read(path);
export const writeFileSync = (path: string, contents: string, _options?: unknown) => runtime.write(path, contents);
export const mkdirSync = (path: string, _options?: unknown) => runtime.mkdir(path);
export const copyFileSync = (source: string, destination: string) => runtime.copy(source, destination);
export const join = (...parts: string[]) => runtime.join(...parts);
export const dirname = (path: string) => runtime.dirname(path);
export const homedir = () => runtime.home;
export const platform = () => runtime.platform;
export const randomUUID = () => runtime.randomUUID();

export function memoryPlatform(options: {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  home?: string;
  platform?: string;
  fetch: typeof globalThis.fetch;
}): { runtime: PlatformRuntime; writes: () => Record<string, string> } {
  const files = new Map(Object.entries(options.files ?? {}).map(([path, value]) => [clean(path), value]));
  const writes = new Map<string, string>();
  const normalize = (path: string) => clean(path);
  const runtime: PlatformRuntime = {
    env: options.env ?? {},
    platform: options.platform ?? "browser",
    home: options.home ?? "/home/user",
    fetch: options.fetch,
    exists: (path) => files.has(normalize(path)),
    read: (path) => {
      const value = files.get(normalize(path));
      if (value === undefined) throw new Error(`read ${path} failed`);
      return value;
    },
    write: (path, contents) => {
      const key = normalize(path);
      files.set(key, contents);
      writes.set(key, contents);
    },
    mkdir: () => {},
    copy: (source, destination) => {
      const value = files.get(normalize(source));
      if (value === undefined) throw new Error(`read ${source} failed`);
      const key = normalize(destination);
      files.set(key, value);
      writes.set(key, value);
    },
    join: (...parts) => clean(parts.filter(Boolean).join("/")),
    dirname: (path) => clean(path).replace(/\/[^/]*$/, "") || "/",
    randomUUID: () => globalThis.crypto.randomUUID(),
  };
  return { runtime, writes: () => Object.fromEntries(writes) };
}
