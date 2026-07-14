
### 1 Watch mode

`--watch` refreshes in place until Ctrl+C. `--interval` (`-i`) implies `--watch`; accepts `30`, `30s`, `1m`; default `60`.

- **TTY**: cursor retract + clear-below, no flicker.
- **Pipe**: append mode, full history preserved.
- **Errors**: transient (network, timeout, 429) retry. 429 triggers **exponential backoff** (`2×, 4×, …` capped at 5 min, resets on success). Fatal (auth, other 4xx/5xx, missing config) exits with code 2.

### 2 Options


| Flag                                | Description                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `-p, --provider <minimax            | openai                                                                                              | claude                         | opencode | deepseek-api>` | Single provider (overrides auth config; default: all enabled) |
| `-r, --region <cn                   | intl>`                                                                                              | MiniMax endpoint (default`cn`) |
| `--codex-auth <PATH>`               | Codex auth (default`$CODEX_HOME/auth.json` or `~/.codex/auth.json`)                                 |
| `--claude-auth <PATH>`              | Claude credentials (default`$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`) |
| `--deepseek-daily-budget <AMOUNT>`  | DeepSeek daily budget override (default: 7)                                                         |
| `--deepseek-weekly-budget <AMOUNT>` | DeepSeek weekly budget override (default: 35)                                                       |
| `--deepseek-config <PATH>`          | DeepSeek budget state file (default `~/.config/ai-quota/api-usage.json`)                            |
| `-w, --watch`                       | Refresh in place (implied by`-i`)                                                                   |
| `-i, --interval <SECS>`             | Refresh interval (`30`/`30s`/`1m`, default `60`; implies `-w`)                                      |
| `-h, --help`                        | Show help                                                                                           |
| `-v, --version`                     | Show version                                                                                        |

Env: `NO_COLOR=1`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `OPENCODE_SERVER`, `OPENCODE_GO_ENV`.

### 3 Auth subcommands

Default behavior queries every **enabled** provider. The set is persisted at
`$XDG_CONFIG_HOME/ai-quota/auth.json` (defaults to `~/.config/ai-quota/auth.json`).
All six providers (`minimax`, `openai`, `claude`, `opencode`, `deepseek-api`, `grok`) are enabled out of the box. The optional `minimax-video` plan is disabled by default.

```bash
ai-quota auth list                          # show every provider/plan and its status
ai-quota auth enable <NAME>                 # turn a provider or plan on (persisted)
ai-quota auth disable <NAME>                # turn it off
```

`--provider <NAME>` is a one-off override — it queries that provider even if it's
disabled in the auth config. Use it for ad-hoc checks; the change doesn't persist.

> Enable the MiniMax video plan with `ai-quota auth enable minimax-video`; disable it again with `ai-quota auth disable minimax-video`.

### 4 OpenCode Go authorization

OpenCode Go quota is read by scraping the workspace dashboard at `opencode.ai/workspace/<id>/go`. This requires a browser session cookie, which the OpenCode CLI does **not** persist — you must extract it once from DevTools.

| Credential                 | Where it goes                            | Source                                                             |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `OPENCODE_GO_WORKSPACE_ID` | env or `~/.config/ai-quota/opencode.env` | URL when visiting the Go dashboard: `/workspace/wrk_xxxxxxxx/go`   |
| `OPENCODE_GO_AUTH_COOKIE`  | env or `~/.config/ai-quota/opencode.env` | Browser DevTools → Application → Cookies → `auth` on `opencode.ai` |

**One-time setup**

```bash
# 1. Log in to opencode.ai in your browser (so the auth cookie exists).

# 2. Grab the workspaceId from the URL when you visit the Go dashboard:
#    https://opencode.ai/workspace/wrk_xxxxxxxx/go
#    ↑ this part

# 3. Grab the auth cookie value from DevTools → Application → Cookies → auth.

# 4. Write both to the env file (auto-loaded by ai-quota):
```

**Linux/macOS/Windows (bash / Git Bash / WSL):**

```bash
install -m 600 /dev/null ~/.config/ai-quota/opencode.env
cat >> ~/.config/ai-quota/opencode.env <<'EOF'
OPENCODE_GO_WORKSPACE_ID="wrk_xxxxxxxx"
OPENCODE_GO_AUTH_COOKIE="Fe26.2**..."
EOF
```

Run `ai-quota --provider opencode` (no `source` needed — the file is auto-loaded). The `auth` cookie is valid for **~1 year** from issue; if scraping suddenly fails with `dashboard auth failed`, re-extract from DevTools.

**Override paths**

```bash
# Different env file path
OPENCODE_GO_ENV=/path/to/my.env ai-quota --provider opencode

# Inline env vars (win over file)
export OPENCODE_GO_WORKSPACE_ID=...
export OPENCODE_GO_AUTH_COOKIE=...
ai-quota --provider opencode

# Self-hosted OpenCode (overrides default https://opencode.ai)
export OPENCODE_SERVER=https://opencode.internal.example.com
```

Without `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`, the OpenCode provider errors out. To disable the provider entirely: `ai-quota auth disable opencode`.

### 5 Grok Build authorization

Grok Build quota (SuperGrok / X Premium+ subscription) is read from the Grok Build CLI proxy at `cli-chat-proxy.grok.com`. Auth prefers the `grok-cli` OAuth entry in pi's `~/.pi/agent/auth.json` (written by pi `/login` / pi-grok-cli). Falls back to official `~/.grok/auth.json` if present. The same billing surface is what `grok /usage` and `pi-xai /xai-usage` query.

**One-time setup**

```bash
# Preferred: log in via pi (writes ~/.pi/agent/auth.json → "grok-cli")
# Inside pi:
#   /login
#   choose Grok CLI / grok-build

# Or: official Grok CLI (fallback path)
#   grok login   # writes ~/.grok/auth.json

# Verify
ai-quota --provider grok
```

Lookup order:
1. `$PI_CONFIG_DIR/auth.json` or `~/.pi/agent/auth.json` — keys `grok-cli` then `grok-build` (`type: oauth`, field `access`)
2. `~/.grok/auth.json` — canonical `https://auth.x.ai::<client-id>` or legacy `https://accounts.x.ai/sign-in`

Without either credential, the Grok provider errors out. To disable: `ai-quota auth disable grok`. Plain `XAI_API_KEY` is **not** sufficient — the billing endpoint requires the subscription OAuth token.

### 6 How it works

Three read-only GETs, no side effects.


| Provider     | Auth                                                                        | Endpoint                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax      | `MINIMAX_CN_API_KEY` (fallback `MINIMAX_API_KEY`)                           | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (intl: `minimax.io`)                                                        |
| OpenAI Codex | OAuth JWT from`~/.codex/auth.json`                                          | `https://chatgpt.com/backend-api/wham/usage` — must use Codex-style headers; `api.openai.com` returns 401                                      |
| Claude Code  | OAuth token from`~/.claude/.credentials.json`                               | `https://api.anthropic.com/api/oauth/usage` — requires `anthropic-beta: oauth-2025-04-20`                                                      |
| OpenCode Go  | Cookie from `~/.config/ai-quota/opencode.env`                               | `https://opencode.ai/workspace/<id>/go` (HTML scrape) — see [OpenCode Go authorization](#opencode-go-authorization)                            |
| DeepSeek API | `DEEPSEEK_API_KEY`                                                          | `https://api.deepseek.com/user/balance` — server only exposes current balance; daily/weekly via local spend ledger                             |
| Grok Build   | OAuth `grok-cli` from`~/.pi/agent/auth.json` (fallback `~/.grok/auth.json`) | `https://cli-chat-proxy.grok.com/v1/billing` (+ `?format=credits` for weekly pool) — see [Grok Build authorization](#grok-build-authorization) |

OpenAI retries 3× on transient `UND_ERR_CONNECT_TIMEOUT` (Cloudflare). Claude retries 3× on transient network errors. See [claude-code-quota](https://github.com/aweussom/claude-code-quota) for the Claude endpoint reverse-engineering notes; [minimax-coding-plan-quota-query](https://github.com/yunluoxin/minimax-coding-plan-quota-query) for MiniMax; [opencode-quota](https://github.com/slkiser/opencode-quota) for the OpenCode Go dashboard scraping pattern; [pi-xai](https://github.com/luxus/pi-xai) for the Grok Build billing surface (`xai-oauth.ts`).
