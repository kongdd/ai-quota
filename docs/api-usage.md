# 1 api-usage

`api-usage` shows **account balance** and local **daily + weekly + monthly budget progress** for DeepSeek (`provider: deepseek-api`). It reads `GET /user/balance`; this is a read-only balance check, not a model call.

```bash
export DEEPSEEK_API_KEY="sk-..."

api-usage                         # default daily 7 / weekly 35 / monthly 70 CNY
api-usage -i 60s                  # refresh in place
api-usage --reset-today           # reset today's + week/month baselines
```

Output shape:

```text
2026-07-02 20:20:04  deepseek-api
  balance  ¥ 18.07
  daily    ¥  7.00 / ¥  7.00  ░░░░░░░░░░░░░░░░░░░░░░░░ 0.0%
  weekly   ¥ 10.00 / ¥ 10.00  ░░░░░░░░░░░░░░░░░░░░░░░░ 0.0%
  monthly  ¥ 70.00 / ¥ 70.00  ░░░░░░░░░░░░░░░░░░░░░░░░ 0.0%
```

- **account ledger** — stores `last_balance` and `updated_at`, so the next run can persist the balance drop since the previous run.
- **daily record** — first run of each local day stores a baseline; later runs accumulate balance drops into that day's `spent`.
- **weekly record** — first run of each ISO week (Monday-start) stores a baseline; later runs accumulate balance drops into that week's `spent`.
- **top-ups** — balance increases update `last_balance` but do not reduce recorded `spent`.
- `--reset-today` resets both records to the current balance and clears recorded `spent`.

Budget amounts are persisted once set (CLI > env > state). Env vars: `DEEPSEEK_DAILY_BUDGET` / `DEEPSEEK_WEEKLY_BUDGET`. DeepSeek's public API only exposes `/user/balance`; this is a local spend ledger, not a server-side cap.
