# OpenAI 新授权与额度查询

新版订阅共享额度可以查询，但现有接口仍要求 Codex / ChatGPT 后端凭据，不能直接使用 Pi 新版 `openai` token。

## 查询方式

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <Codex OAuth access token>
ChatGPT-Account-ID: <account id, if available>
OAI-App-Brand: chatgpt
```

同一响应包含不同额度：

- `rate_limit`：普通 Codex 额度，显示为 `codex`。
- `chatpass.windows`：订阅共享池，显示为 `openai·apps`；目前读取 5 小时和周窗口，按 `limit_window_seconds` 匹配，不依赖数组顺序。

共享池不是某个应用单独设置的上限；不据此推断 Pi 一定还能继续请求。窗口缺失时不补造百分比或重置时间。

## 核查结果

核查日期：2026-10-02。仅使用只读 GET，未生成模型响应，未刷新或改写授权凭据。

| 凭据与请求 | 实测结果 |
|---|---|
| Pi 新版 `openai` OAuth → `api.openai.com/v1/models` | 200，确认 token 有效 |
| 同一新 token → `chatgpt.com/backend-api/wham/usage` | 401，`no_matching_rule`；加入 `OAI-App-Brand: chatgpt` 后仍失败 |
| 同一新 token → `api.openai.com/v1/usage` | 401，`invalid_api_key` |
| 同一新 token → `api.openai.com/api/codex/usage` | 404 |
| 同一新 token → `api.openai.com/v1/api/codex/usage` | 404 |
| Codex OAuth → WHAM，加入 `OAI-App-Brand: chatgpt` | 200，包含 `rate_limit` 和 `chatpass.windows` |

因此 ai-quota 识别新版登录，但用已有 legacy / Codex 凭据读取这两组额度。仅有新 token 时，明确提示补充 Codex 授权或打开 ChatGPT Usage；不会反复重试已知不兼容的接口。

## 源码与文档依据

- [Codex 配额请求](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)：`get_rate_limit_status()` 发起 GET；按后端路径类型选择 `/wham/usage` 或 `/api/codex/usage`。后一个路径不意味着 `api.openai.com` 提供该接口。
- [Codex app-server 配额入口](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs)：`get_account_rate_limits_response()` 要求 `auth.uses_codex_backend()`，再调用上述后端客户端。
- [OpenAI 新授权推理接口](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：新 token 用于 `api.openai.com/v1`；明确不应指向 ChatGPT `backend-api`。
- [OpenAI 用量界面指南](https://developers.openai.com/siwc/ui-ux-guidelines)：引导用户在 ChatGPT Usage 查看和管理计划及应用上限。
- [ChatPass 窗口结构调查](https://runtimewire.com/article/openai-is-building-subscription-sharing-for-ai-apps)：描述 `OAI-App-Brand: chatgpt` 与 `chatpass.windows`；本次已在真实响应中验证，不仅依赖调查文章。
