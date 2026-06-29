# ai-quota

AI coding-plan quota (MiniMax / OpenAI Codex / Claude Code) in the terminal. Zero runtime dependencies, read-only GETs, no quota consumed.

## Install

```bash
./install.sh
```

> **Z:/networked drives**: the repo's `.npmrc` sets `bin-links=false`; pass `--bin-links=true` to `npm link`, or run `npm link` from outside the project so the per-project `.npmrc` doesn't apply.

`npm link` symlinks `<prefix>/bin/ai-quota` → this repo's `dist/cli.js`. Re-running `npm run build` (or `./install.sh`) refreshes the binary in place — no re-link needed. Unlink with `npm unlink -g ai-quota`.

## Usage

![usage](docs/ai-quota_V2.png)

<!-- OpenAI / Claude blocks have the same shape, with their own provider line (`OpenAI Codex` / `Claude Code`).  -->

Color coding: green (< 50%), yellow (< 80%), red (≥ 80%).

```bash
ai-quota                                  # all enabled providers
ai-quota --provider minimax --region intl # one-off override; ignores auth config
ai-quota --watch -i 30s                   # refresh in place every 30s
ai-quota auth list                        # see which providers are enabled
ai-quota auth disable opencode            # skip a provider next time
ai-quota auth enable opencode             # bring it back
```

Auth: `MINIMAX_API_KEY` env only; OpenAI reads `~/.codex/auth.json`; Claude reads `~/.claude/.credentials.json`; OpenCode reads `~/.local/share/opencode/auth.json`. A missing provider doesn't abort the others.

Auth: `MINIMAX_API_KEY` env (or `--key`); OpenAI reads `~/.codex/auth.json`; Claude reads `~/.claude/.credentials.json`. A missing provider doesn't abort the others.

### Watch mode

`--watch` refreshes in place until Ctrl+C. `--interval` (`-i`) implies `--watch`; accepts `30`, `30s`, `1m`; default `60`.

- **TTY**: cursor retract + clear-below, no flicker.
- **Pipe**: append mode, full history preserved.
- **Errors**: transient (network, timeout, 429) retry. 429 triggers **exponential backoff** (`2×, 4×, …` capped at 5 min, resets on success). Fatal (auth, other 4xx/5xx, missing config) exits with code 2.

### Options


| Flag                     | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `-p, --provider <minimax | openai                                                                                              | claude                         | opencode>` | Single provider (overrides auth config; default: all enabled) |
| `-r, --region <cn        | intl>`                                                                                              | MiniMax endpoint (default`cn`) |
| `--codex-auth <PATH>`    | Codex auth (default`$CODEX_HOME/auth.json` or `~/.codex/auth.json`)                                 |
| `--claude-auth <PATH>`   | Claude credentials (default`$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`) |
| `--opencode-auth <PATH>` | OpenCode auth (default`$XDG_DATA_HOME/opencode/auth.json` or `~/.local/share/opencode/auth.json`)   |
| `-w, --watch`            | Refresh in place (implied by`-i`)                                                                   |
| `-i, --interval <SECS>`  | Refresh interval (`30`/`30s`/`1m`, default `60`; implies `-w`)                                      |
| `-h, --help`             | Show help                                                                                           |
| `-v, --version`          | Show version                                                                                        |

Env: `NO_COLOR=1`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`.

### Auth subcommands

Default behavior queries every **enabled** provider. The set is persisted at
`$XDG_CONFIG_HOME/ai-quota/auth.json` (defaults to `~/.config/ai-quota/auth.json`).
All four providers (`minimax`, `openai`, `claude`, `opencode`) are enabled out of the box.

```bash
ai-quota auth list                          # show every provider/plan and its status
ai-quota auth enable <NAME>                 # turn a provider or plan on (persisted)
ai-quota auth disable <NAME>                # turn it off
```

`--provider <NAME>` is a one-off override — it queries that provider even if it's
disabled in the auth config. Use it for ad-hoc checks; the change doesn't persist.

> MiniMax video plan is hardcoded off: it's not in `KNOWN_ITEMS`, so `auth enable minimax video` errors out and the video row never reaches the report.

### OpenCode Go authorization

OpenCode Go needs **two separate credentials**:


| Credential                  | Where it goes                           | Source                                                                                           |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Bearer token (`auth.json`)  | `$XDG_DATA_HOME/opencode/auth.json`     | `opencode auth login` (OAuth device flow) **or** API key from the Go console (set `type: "api"`) |
| Web session cookie (`auth`) | `~/.config/ai-quota/opencode.env` (env) | Browser DevTools → Application → Cookies on`opencode.ai`                                         |

**Why two?** The `auth.json` Bearer token only authenticates API calls (`/zen/go/v1/chat/completions`); it is **not** a valid web session. OpenCode Go's quota dashboard at `opencode.ai/workspace/<id>/go` requires the browser session cookie, which OpenCode CLI does **not** persist. Without the cookie, `ai-quota` falls back to a free Bearer probe and reports `no quota data`.

**One-time setup**

```bash
# 1. Log in to opencode.ai in your browser (so the auth cookie exists).

# 2. Grab the workspaceId from the URL when you visit Go dashboard:
#    https://opencode.ai/workspace/wrk_xxxxxxxx/go
#    ↑ this part

# 3. Grab the auth cookie value from DevTools → Application → Cookies → auth.

# 4. Write both to ~/.config/ai-quota/opencode.env (auto-loaded by ai-quota):
cat > ~/.config/ai-quota/opencode.env <<EOF
export OPENCODE_GO_WORKSPACE_ID="wrk_xxxxxxxx"
export OPENCODE_GO_AUTH_COOKIE="Fe26.2**..."
EOF
chmod 600 ~/.config/ai-quota/opencode.env
```

Run `ai-quota --provider opencode` (no `source` needed — the file is auto-loaded). The `auth` cookie is valid for **~1 year** from issue; if scraping suddenly fails with `dashboard auth failed`, re-extract from DevTools.

**Override paths**

```bash
# Different auth.json path
ai-quota --provider opencode --opencode-auth /custom/path/auth.json

# Different env file path (or inline env vars)
OPENCODE_GO_ENV=/path/to/my.env ai-quota --provider opencode
export OPENCODE_GO_WORKSPACE_ID=...
export OPENCODE_GO_AUTH_COOKIE=...   # inline env wins over file
ai-quota --provider opencode

# Self-hosted OpenCode
export OPENCODE_SERVER=https://opencode.internal.example.com
```

Without `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`, the OpenCode provider runs in **probe-only mode**: it validates the Bearer token against `/zen/go/v1/models` and returns `no quota data`. To disable the provider entirely: `ai-quota auth disable opencode`.

## How it works

Three read-only GETs, no side effects.


| Provider     | Auth                                                                                           | Endpoint                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MiniMax      | `MINIMAX_API_KEY`                                                                              | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (intl: `minimax.io`)                             |
| OpenAI Codex | OAuth JWT from`~/.codex/auth.json`                                                             | `https://chatgpt.com/backend-api/wham/usage` — must use Codex-style headers; `api.openai.com` returns 401           |
| Claude Code  | OAuth token from`~/.claude/.credentials.json`                                                  | `https://api.anthropic.com/api/oauth/usage` — requires `anthropic-beta: oauth-2025-04-20`                           |
| OpenCode Go  | Bearer from`~/.local/share/opencode/auth.json` + cookie from `~/.config/ai-quota/opencode.env` | `https://opencode.ai/workspace/<id>/go` (HTML scrape) — see [OpenCode Go authorization](#opencode-go-authorization) |

OpenAI retries 3× on transient `UND_ERR_CONNECT_TIMEOUT` (Cloudflare). Claude retries 3× on transient network errors. OpenCode Go falls back to a free probe of `https://opencode.ai/zen/go/v1/models` when the dashboard cookie is not configured. See [claude-code-quota](https://github.com/aweussom/claude-code-quota) for the Claude endpoint reverse-engineering notes; [minimax-coding-plan-quota-query](https://github.com/yunluoxin/minimax-coding-plan-quota-query) for MiniMax; [opencode-quota](https://github.com/slkiser/opencode-quota) for the OpenCode Go dashboard scraping pattern.
