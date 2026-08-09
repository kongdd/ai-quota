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
ai-quota query reset-card -p codex   # show Codex reset cards

# 1week 10￥ / 1mon 70￥
ai-quota budget -p deepseek-api -w 10 -m 70
```

## JSON API

```bash
ai-quota serve                         # http://127.0.0.1:8787
curl http://127.0.0.1:8787/api/v1/quotas

export AI_QUOTA_API_TOKEN="$(openssl rand -hex 32)"
ai-quota serve --host 0.0.0.0          # remote access requires bearer token
```

Endpoints and schema: [docs/api.md](docs/api.md).

## Earth Engine

```bash
# 先由 Earth Engine 完成授权
ee-quota config set project gee-kongdd
ee-quota config --unit h   # s 或 h
ee-quota                         # 查询当前项目月额度
```

需要先完成 Earth Engine 授权，凭据默认位于 `~/.config/earthengine/credentials`。详见 [Earth Engine Authentication](https://developers.google.com/earth-engine/guides/auth)。

## Android App

`apps/mobile/` 是 React + TypeScript + Tauri 2 客户端：

![AI Quota Android](images/dashboard.png)

- Codex、Grok 使用与 Pi 相同的 Device Code OAuth，在手机端直接授权和查询。
- OAuth 凭据写入 Android 应用私有目录的 `auth.json`，不进入浏览器存储。
- 其他 Provider 可连接 `ai-quota serve`；建议使用 HTTPS 或 Tailscale。
- 包含 Codex 重置卡、深浅色主题和移动端响应式界面。

```bash
npm --prefix apps/mobile install --include=dev
npm run mobile:build
npm run mobile:android:build   # debug APK (aarch64)
```

本机已装用户空间 JDK21 + Android SDK/NDK；产物 `apps/mobile/dist-android/ai-quota-debug.apk`。详见 [apps/mobile/README.md](apps/mobile/README.md)。


  codex·pro  ░░░░░░░░░░  3%  4d  6h  5m ░░░░░░░░░░  3%  4d  6h  5m
  grok       ░░░░░░░░░░  0% 30d 22h 34m ░░░░░░░░░░  0% 30d 22h 34m
  minimax    ░░░░░░░░░░  4%         34m ██░░░░░░░░ 19%  1d 14h 34m
  kimi       ░░░░░░░░░░  0%      1h  1m █░░░░░░░░░ 14%      2h  1m
  deepseek   ░░░░░░░░░░  0%     14h 34m ¥7.89
