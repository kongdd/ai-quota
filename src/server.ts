import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  parseProviders,
  queryCodexResetSnapshot,
  queryQuotaSnapshot,
  type CodexResetSnapshot,
  type Provider,
  type QuotaSnapshot,
} from "./query.js";

const API_VERSION = 1;

export interface ApiServerOptions {
  token?: string;
  corsOrigin?: string;
  query?: (providers?: Provider[]) => Promise<QuotaSnapshot>;
  queryCodexReset?: () => Promise<CodexResetSnapshot>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body) + "\n");
}

function error(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { schemaVersion: API_VERSION, error: { code, message } });
}

function authorized(request: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasLoopbackHost(request: IncomingMessage): boolean {
  try {
    return isLoopback(new URL(`http://${request.headers.host ?? ""}`).hostname);
  } catch {
    return false;
  }
}

function setCors(request: IncomingMessage, response: ServerResponse, origin?: string): void {
  if (!origin || request.headers.origin !== origin) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Vary", "Origin");
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const query = options.query ?? ((providers) => queryQuotaSnapshot({ providers }));
  const queryCodexReset = options.queryCodexReset ?? queryCodexResetSnapshot;
  return createServer(async (request, response) => {
    setCors(request, response, options.corsOrigin);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!options.token && !hasLoopbackHost(request)) {
      return error(response, 403, "forbidden", "localhost Host header required without API token");
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return error(response, 400, "bad_request", "invalid request URL");
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      json(response, 200, {
        schemaVersion: API_VERSION,
        service: "ai-quota",
        status: "ok",
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const isQuotas = url.pathname === "/api/v1/quotas";
    const isCodexReset = url.pathname === "/api/v1/codex/reset-cards";
    if (!isQuotas && !isCodexReset) return error(response, 404, "not_found", "endpoint not found");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return error(response, 405, "method_not_allowed", "only GET is supported");
    }
    if (!authorized(request, options.token)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return error(response, 401, "unauthorized", "valid bearer token required");
    }

    if (isCodexReset) {
      try {
        return json(response, 200, await queryCodexReset());
      } catch (cause) {
        return error(response, 500, "internal_error", cause instanceof Error ? cause.message : String(cause));
      }
    }

    const raw = url.searchParams.get("providers");
    let providers: Provider[] | undefined;
    try {
      providers = raw === null ? undefined : parseProviders(raw);
    } catch (cause) {
      return error(response, 400, "bad_request", cause instanceof Error ? cause.message : String(cause));
    }

    try {
      json(response, 200, await query(providers));
    } catch (cause) {
      error(response, 500, "internal_error", cause instanceof Error ? cause.message : String(cause));
    }
  });
}

export interface StartApiServerOptions extends ApiServerOptions {
  host?: string;
  port?: number;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export async function startApiServer(options: StartApiServerOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer between 1 and 65535");
  if (!isLoopback(host) && !options.token) throw new Error("AI_QUOTA_API_TOKEN is required when listening outside localhost");

  const server = createApiServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export const SERVE_HELP = `ai-quota serve — local JSON API\n\nUsage: ai-quota serve [options]\n\nOptions:\n      --host <HOST>          Listen address (default: 127.0.0.1)\n      --port <PORT>          Listen port (default: 8787)\n      --cors-origin <ORIGIN> Allowed browser origin (exact match)\n  -h, --help                 Show this help\n\nEnvironment:\n  AI_QUOTA_API_TOKEN         Bearer token; required outside localhost\n\nEndpoints:\n  GET /api/v1/health\n  GET /api/v1/quotas\n  GET /api/v1/quotas?providers=openai,claude\n  GET /api/v1/codex/reset-cards\n`;

export async function runServeCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      "cors-origin": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(SERVE_HELP);
    return;
  }

  const host = values.host;
  const port = Number(values.port);
  const server = await startApiServer({
    host,
    port,
    token: process.env.AI_QUOTA_API_TOKEN,
    corsOrigin: values["cors-origin"],
  });
  process.stdout.write(`ai-quota API listening on http://${host}:${port}\n`);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
