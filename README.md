# ai-quota

Show AI coding-plan quota (MiniMax / OpenAI Codex) in the terminal. Zero runtime dependencies.

## Install

```bash
npm install
npm run build
npm link --bin-links=true   # exposes `ai-quota` on PATH
```

> **Note for Z:/networked drives:** the repo's `.npmrc` sets `bin-links=false` because those filesystems don't support symlinks. `npm link` will register the package but won't create the `bin` symlink. Override with `--bin-links=true` (or run `npm link` from outside the project so the per-project `.npmrc` doesn't apply).

## Usage

By default `ai-quota` queries **both** providers in parallel and prints each result. Use `--provider` to limit to a single one.

```bash
# Both providers (default)
ai-quota
export MINIMAX_API_KEY=sk-cp-xxxxxxxx   # needed for the MiniMax block
ai-quota                                  # both blocks in one run

# Single provider
ai-quota --provider minimax --region intl
ai-quota --provider openai                # reads ~/.codex/auth.json
```

Or pass the MiniMax key directly:

```bash
ai-quota --provider minimax --key sk-cp-xxxxxxxx
```

If the MiniMax key is missing in default mode, only the OpenAI block is printed (and vice versa) — failure of one provider does not abort the other.

### Options

| Flag                               | Description                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `-p, --provider <minimax\|openai>` | Single provider (default: both)                                                  |
| `-k, --key <KEY>`                  | MiniMax API key (or env `MINIMAX_API_KEY`)                                       |
| `-r, --region <cn\|intl>`          | MiniMax endpoint (default `cn`)                                                  |
| `-g, --group-id <ID>`              | MiniMax group ID (optional query param)                                          |
| `--codex-auth <PATH>`              | Codex `auth.json` path (default `$CODEX_HOME/auth.json` or `~/.codex/auth.json`) |
| `-h, --help`                       | Show help                                                                        |
| `-v, --version`                    | Show version                                                                     |

Environment: `NO_COLOR=1` disables ANSI colors. `CODEX_HOME` overrides the default Codex home directory.

## Output

### MiniMax

```
MiniMax Coding Plan · 2026-06-17 11:38:11

── usage ──
  Model          5h                     week
  MiniMax-M3     ██░░░░░░░  25%  4h 58m ███░░░░░░░  30%  6d 22h 50m
  MiniMax-M2     █████████▌  96%  14m    ████████░  84%  1d 1h 33m
```

### OpenAI Codex

```
OpenAI Codex · 2026-06-17 16:25:21

── usage ──
  Model          5h                 week
  codex · plus   ██████░░░░ 54% 34m █████░░░░░ 42% 19h 34m
```

Color coding: green (< 50%), yellow (< 80%), red (≥ 80%).

## How it works

### MiniMax

Calls `GET /v1/api/openplatform/coding_plan/remains` on the chosen region's MiniMax API with a Bearer token. The response's `model_remains` is split into a 5-hour window and a weekly window per model. See [API info](https://github.com/yunluoxin/minimax-coding-plan-quota-query).

### OpenAI Codex

Reads `~/.codex/auth.json` for the ChatGPT OAuth JWT (set up via `codex login`), then `GET`s `https://chatgpt.com/backend-api/wham/usage` with Codex-style headers. The response is JSON containing the active 5-hour window (`primary_window`) and weekly window (`secondary_window`), plus `plan_type`, `credits`, and `spend_control`.

The headers (`User-Agent: codex_cli_rs/0.0.0`, `OpenAI-Beta: responses_websockets=2026-02-06`, `session-id`, `thread-id`, `chatgpt-account-id`) make the request look like Codex CLI traffic to the ChatGPT backend. Sending the JWT to `api.openai.com` instead returns 401 "Missing scopes" — ChatGPT Plus tokens are not authorized for the OpenAI API gateway.

The call is a single read-only GET: **no tokens consumed, no side effects**. Retries 3× on transient `UND_ERR_CONNECT_TIMEOUT` (Cloudflare fronting `chatgpt.com` is flaky from some networks).

## Endpoints

| Provider | Region | URL                                                                |
| -------- | ------ | ------------------------------------------------------------------ |
| MiniMax  | cn     | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` |
| MiniMax  | intl   | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains`   |
| OpenAI   | —      | `https://chatgpt.com/backend-api/wham/usage`                       |

Coding Plan keys (`sk-cp-…`) only work on the platform that issued them; pass `--region` to match.

## License

MIT
