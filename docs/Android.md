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

```bash
  codex·pro  ░░░░░░░░░░  3%  4d  6h  5m ░░░░░░░░░░  3%  4d  6h  5m
  grok       ░░░░░░░░░░  0% 30d 22h 34m ░░░░░░░░░░  0% 30d 22h 34m
  minimax    ░░░░░░░░░░  4%         34m ██░░░░░░░░ 19%  1d 14h 34m
  kimi       ░░░░░░░░░░  0%      1h  1m █░░░░░░░░░ 14%      2h  1m
  deepseek   ░░░░░░░░░░  0%     14h 34m ¥7.89
```
