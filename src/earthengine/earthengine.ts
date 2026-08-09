import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EeQuotaUnit = "s" | "h";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "517222506229-vsmmajv00ul0bs7p89v5m89qs8eb9359.apps.googleusercontent.com";
const CLIENT_SECRET = "RUP0RZ6e0pPhDzsqIJ7KlNd1";

type EarthEngineConfig = {
  [key: string]: unknown;
  eeQuota?: { unit?: string };
};

type EarthEngineCredentials = {
  [key: string]: unknown;
  refresh_token?: string;
  project?: string;
};

function userConfigDir(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function earthEngineConfigPath(): string {
  return join(userConfigDir(), "ai-quota", "config.json");
}

export function earthEngineCredentialsPath(): string {
  return process.env.EARTHENGINE_CREDENTIALS ?? join(homedir(), ".config", "earthengine", "credentials");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  if (mode === undefined) writeFileSync(path, text);
  else {
    writeFileSync(path, text, { mode });
    try { chmodSync(path, mode); } catch {}
  }
}

function loadConfig(): EarthEngineConfig {
  return readJson<EarthEngineConfig>(earthEngineConfigPath()) ?? {};
}

function saveConfig(config: EarthEngineConfig): void {
  writeJson(earthEngineConfigPath(), config);
}

function loadCredentials(): EarthEngineCredentials {
  const path = earthEngineCredentialsPath();
  if (!existsSync(path)) throw new Error(`Earth Engine credentials not found: ${path}`);
  const credentials = readJson<EarthEngineCredentials>(path);
  if (!credentials) throw new Error(`invalid Earth Engine credentials: ${path}`);
  return credentials;
}

function saveCredentials(credentials: EarthEngineCredentials): void {
  writeJson(earthEngineCredentialsPath(), credentials, 0o600);
}

export function getEeQuotaUnit(): EeQuotaUnit {
  return loadConfig().eeQuota?.unit === "h" ? "h" : "s";
}

export function setEeQuotaUnit(unit: EeQuotaUnit): void {
  const config = loadConfig();
  saveConfig({ ...config, eeQuota: { ...config.eeQuota, unit } });
}

export function getEeQuotaProject(): string | undefined {
  const project = loadCredentials().project?.trim();
  return project || undefined;
}

export function setEeQuotaProject(project: string): void {
  const credentials = loadCredentials();
  credentials.project = project.trim();
  saveCredentials(credentials);
}

let cachedToken: { value: string; expiresAt: number } | undefined;

export async function getEarthEngineAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const credentials = loadCredentials();
  if (!credentials.refresh_token) throw new Error("Earth Engine refresh_token is missing; authenticate with Earth Engine first");
  const response = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown; error?: string; error_description?: string };
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(`Earth Engine token refresh failed: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}`);
  }
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 };
  return payload.access_token;
}
