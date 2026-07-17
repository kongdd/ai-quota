<h1>ai-quota</h1>

> AI剩余额度查询，推荐搭配pi-agent使用   
> Zero runtime dependencies, read-only GETs, no quota consumed.   


![usage](docs/ai-quota_V4.png)
> Color: green (< 50%), yellow (< 80%), red (≥ 80%).

## Supports

- [x] Claude code         : `~/.claude/.credentials.json`
- [x] OpenAI Codex        : `~/.codex/auth.json`
- [x] Grok build          : `~/.pi/agent/auth.json`
- [x] Opencode go         : `~/.config/ai-quota/opencode.env`
- [x] Minimax coding plan : `MINIMAX_CN_API_KEY` or `MINIMAX_API_KEY` env
- [x] DeepSeek API        : `DEEPSEEK_API_KEY`
- [x] Kimi coding plan    : **待测试**，`KIMI_API_KEY` or `MOONSHOT_API_KEY` env
- [x] Zhipu coding plan   : **待测试**，`ZHIPU_CN_API_KEY` or `ZHIPU_API_KEY` env (cn/intl regions)

## Usage

```bash
bun install -g ai-quota # install
```

```bash
ai-quota auth list                    # see which providers are enabled
ai-quota auth disable opencode        # skip a provider next time
ai-quota auth enable opencode         # bring it back

ai-quota                              # all enabled providers
ai-quota -p minimax                   # one-off override; ignores auth config
ai-quota -i 30s                       # refresh in place every 30s

# 1week 10￥ / 1mon 70￥
ai-quota budget -p deepseek-api -w 10 -m 70
```
