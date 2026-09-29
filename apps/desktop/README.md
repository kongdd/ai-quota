# AI Quota Desktop

Tauri 2 托盘界面，构建时直接打包 `ai-quota` 的浏览器核心。

```bash
npm install
npm run tauri dev
# macOS 打包（需 Xcode Command Line Tools 和 Rust）
npm run tauri build
```

无需 Server、Node.js、sidecar 或额外安装 `ai-quota`。macOS 日志位于 `~/.config/ai-quota/log.txt`；首次启动后自动注册用户登录启动（`~/Library/LaunchAgents/io.github.kongdd.aiquota.desktop.plist`）。

- macOS / Windows：双击托盘图标打开设置；Linux：单击打开。
- 右键托盘图标：刷新、设置、退出。
