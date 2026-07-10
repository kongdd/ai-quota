<h1>ai-quota</h1>

AI coding-plan quota (MiniMax / OpenAI Codex / Claude Code / OpenCode Go / DeepSeek API) and API usage budget in the terminal. Zero runtime dependencies, read-only GETs, no quota consumed.

## 1 Install

```bash
./install.sh
```

> **Z:/networked drives**: the repo's `.npmrc` sets `bin-links=false`; pass `--bin-links=true` to `npm link`, or run `npm link` from outside the project so the per-project `.npmrc` doesn't apply.

`npm link` symlinks `<prefix>/bin/ai-quota` → this repo's `dist/cli.js`. Re-running `npm run build` (or `./install.sh`) refreshes the binary in place — no re-link needed. Unlink with `npm unlink -g ai-quota`.

## 2 Usage

![usage](docs/ai-quota_V3.png)

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

Auth: `MINIMAX_API_KEY` env only; OpenAI reads `~/.codex/auth.json`; Claude reads `~/.claude/.credentials.json`; OpenCode reads `~/.config/ai-quota/opencode.env`. A missing provider doesn't abort the others.

## 3 API daily usage budget

`api-usage` shows **account balance** and local **daily + weekly budget progress** for DeepSeek (`provider: deepseek-api`). It reads `GET /user/balance`; this is a read-only balance check, not a model call.

```bash
export DEEPSEEK_API_KEY="sk-..."

api-usage                         # default daily 7 / weekly 35 CNY
api-usage --budget 10             # override daily budget to 10 CNY
api-usage --weekly-budget 50      # override weekly budget to 50 CNY
api-usage --watch -i 30s          # refresh in place every 30s
api-usage --reset-today           # reset today's + this week's baseline
api-usage --currency USD          # show USD balance if the account has USD balance_infos
```

Output shape:

```text
2026-07-02 20:20:04
  provider       deepseek-api
  account        ¥ 18.07 total  (¥ 0.00 granted + ¥ 18.07 topped-up)
  weekly budget  ¥ 35.00 left / ¥ 35.00  ░░░░░░░░░░░░░░░░░░░░░░░░ 0.0% used
  daily budget   ¥  7.00 left / ¥  7.00  ░░░░░░░░░░░░░░░░░░░░░░░░ 0.0% used
  today spent    ¥ 0.00 since 2026-07-02
  day baseline   ¥ 18.07  2026-07-02T12:20:04.949Z
  week spent     ¥ 0.00 since 2026-06-29
  week baseline  ¥ 18.07  2026-07-02T12:20:04.949Z
```

State persisted in `~/.config/ai-quota/api-usage.json`:
- **account ledger** — stores `last_balance` and `updated_at`, so the next run can persist the balance drop since the previous run.
- **daily record** — first run of each local day stores a baseline; later runs accumulate balance drops into that day's `spent`.
- **weekly record** — first run of each ISO week (Monday-start) stores a baseline; later runs accumulate balance drops into that week's `spent`.
- **top-ups** — balance increases update `last_balance` but do not reduce recorded `spent`.
- `--reset-today` resets both records to the current balance and clears recorded `spent`.

Budget amounts are persisted once set (CLI > env > state). Env vars: `DEEPSEEK_DAILY_BUDGET` / `DEEPSEEK_WEEKLY_BUDGET`. DeepSeek's public API only exposes `/user/balance`; this is a local spend ledger, not a server-side cap.

### 3.1 Watch mode

`--watch` refreshes in place until Ctrl+C. `--interval` (`-i`) implies `--watch`; accepts `30`, `30s`, `1m`; default `60`.

- **TTY**: cursor retract + clear-below, no flicker.
- **Pipe**: append mode, full history preserved.
- **Errors**: transient (network, timeout, 429) retry. 429 triggers **exponential backoff** (`2×, 4×, …` capped at 5 min, resets on success). Fatal (auth, other 4xx/5xx, missing config) exits with code 2.

### 3.2 Options


| Flag                     | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `-p, --provider <minimax|openai|claude|opencode|deepseek-api>` | Single provider (overrides auth config; default: all enabled) |
| `-r, --region <cn|intl>` | MiniMax endpoint (default`cn`) |
| `--codex-auth <PATH>`    | Codex auth (default`$CODEX_HOME/auth.json` or `~/.codex/auth.json`)                                 |
| `--claude-auth <PATH>`   | Claude credentials (default`$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`) |
| `--deepseek-daily-budget <AMOUNT>` | DeepSeek daily budget override (default: 7) |
| `--deepseek-weekly-budget <AMOUNT>` | DeepSeek weekly budget override (default: 35) |
| `--deepseek-config <PATH>` | DeepSeek budget state file (default `~/.config/ai-quota/api-usage.json`) |
| `-w, --watch`            | Refresh in place (implied by`-i`)                                                                   |
| `-i, --interval <SECS>`  | Refresh interval (`30`/`30s`/`1m`, default `60`; implies `-w`)                                      |
| `-h, --help`             | Show help                                                                                           |
| `-v, --version`          | Show version                                                                                        |

Env: `NO_COLOR=1`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `OPENCODE_SERVER`, `OPENCODE_GO_ENV`.

### 3.3 Auth subcommands

Default behavior queries every **enabled** provider. The set is persisted at
`$XDG_CONFIG_HOME/ai-quota/auth.json` (defaults to `~/.config/ai-quota/auth.json`).
All five providers (`minimax`, `openai`, `claude`, `opencode`, `deepseek-api`) are enabled out of the box. The optional `minimax-video` plan is disabled by default.

```bash
ai-quota auth list                          # show every provider/plan and its status
ai-quota auth enable <NAME>                 # turn a provider or plan on (persisted)
ai-quota auth disable <NAME>                # turn it off
```

`--provider <NAME>` is a one-off override — it queries that provider even if it's
disabled in the auth config. Use it for ad-hoc checks; the change doesn't persist.

> Enable the MiniMax video plan with `ai-quota auth enable minimax-video`; disable it again with `ai-quota auth disable minimax-video`.

### 3.4 OpenCode Go authorization

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

## 4 How it works

Three read-only GETs, no side effects.


| Provider     | Auth                                          | Endpoint                                                                                                            |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MiniMax      | `MINIMAX_API_KEY`                             | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (intl: `minimax.io`)                             |
| OpenAI Codex | OAuth JWT from`~/.codex/auth.json`            | `https://chatgpt.com/backend-api/wham/usage` — must use Codex-style headers; `api.openai.com` returns 401           |
| Claude Code  | OAuth token from`~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` — requires `anthropic-beta: oauth-2025-04-20`                           |
| OpenCode Go  | Cookie from `~/.config/ai-quota/opencode.env` | `https://opencode.ai/workspace/<id>/go` (HTML scrape) — see [OpenCode Go authorization](#opencode-go-authorization) |
| DeepSeek API | `DEEPSEEK_API_KEY`                            | `https://api.deepseek.com/user/balance` — server only exposes current balance; daily/weekly via local spend ledger |

OpenAI retries 3× on transient `UND_ERR_CONNECT_TIMEOUT` (Cloudflare). Claude retries 3× on transient network errors. See [claude-code-quota](https://github.com/aweussom/claude-code-quota) for the Claude endpoint reverse-engineering notes; [minimax-coding-plan-quota-query](https://github.com/yunluoxin/minimax-coding-plan-quota-query) for MiniMax; [opencode-quota](https://github.com/slkiser/opencode-quota) for the OpenCode Go dashboard scraping pattern.
