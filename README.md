# minimax-quota

Show [MiniMax](https://www.minimax.io) Coding Plan 5-hour and weekly quota in the terminal. Zero runtime dependencies.

## Install

```bash
npm install
npm run build
npm link --bin-links=true   # exposes `minimax-quota` on PATH
```

> **Note for Z:/networked drives:** the repo's `.npmrc` sets `bin-links=false` because those filesystems don't support symlinks. `npm link` will register the package but won't create the `bin` symlink. Override with `--bin-links=true` (or run `npm link` from outside the project so the per-project `.npmrc` doesn't apply).

## Usage

```bash
export MINIMAX_API_KEY=sk-cp-xxxxxxxx
minimax-quota
minimax-quota --region intl
minimax-quota --group-id 12345
```

Or pass the key directly:

```bash
minimax-quota --key sk-cp-xxxxxxxx
```

### Options

| Flag | Description |
|---|---|
| `-k, --key <KEY>` | API key (or env `MINIMAX_API_KEY`) |
| `-r, --region <cn\|intl>` | Endpoint region (default `cn`) |
| `-g, --group-id <ID>` | Group ID (optional query param) |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

Environment: `NO_COLOR=1` disables ANSI colors.

## Output

```
MiniMax Coding Plan · 2026-06-17 11:38:11

── 5h ──
  MiniMax-M3           ██░░░░░░░  25%  377 left  reset 2026-06-17 16:36:08
  MiniMax-M2           █████████▌  96%  20 left   reset 2026-06-17 16:30:11
  next reset in 4h 52m

── week ──
  MiniMax-M3           ███░░░░░░░  30%  3,500 left  reset 2026-06-24 11:13:11
  MiniMax-M2           ████████░  84%  800 left    reset 2026-06-24 10:28:11
  next reset in 6d 22h 50m
```

Color coding: green (< 50%), yellow (< 80%), red (≥ 80%).

## How it works

Calls `GET /v1/api/openplatform/coding_plan/remains` on the chosen region's MiniMax API with a Bearer token. The response's `model_remains` is split into a 5-hour window (entries whose end-time is within 6 hours of now) and a weekly window. See [API info](https://github.com/yunluoxin/minimax-coding-plan-quota-query).

## Endpoints

| Region | URL |
|---|---|
| cn | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` |
| intl | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` |

Coding Plan keys (`sk-cp-…`) only work on the platform that issued them; pass `--region` to match.

## License

MIT
