# OpenAI 新授权与额度查询

Pi 新版 `openai` 应用额度可通过专用接口查询：使用 Codex 后端凭据读取应用列表，再按新版 OAuth token 的 `client_id` 唯一匹配。普通 WHAM 响应没有 `chatpass`，不代表应用额度无法查询。

## 查询方式

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <Codex OAuth access token>
ChatGPT-Account-ID: <account id, if available>
OAI-App-Brand: chatgpt
```

有新版 Pi OAuth 时，再使用同一 Codex 后端凭据请求：

```http
GET https://chatgpt.com/backend-api/wham/usage/chatpass/apps
```

- 普通 `/usage` 的 `rate_limit`：Codex 额度，显示为 `codex`。
- `/usage/chatpass/apps` 的 `items`：应用列表，仅取 `id` 等于当前 Pi token 的 `client_id` 的唯一记录；其 `windows` 显示为 `openai·apps`。
- 未配置可识别的新授权时，仍兼容普通 `/usage` 可选的 `chatpass.windows`。

应用窗口目前支持 5 小时和周周期，按 `limit_window_seconds` 匹配，不依赖顺序。`allowed_usage_percent` 是配置上限，不是剩余额度，不能用来绘制用量。应用未唯一匹配或缺少有效窗口时明确报错；不会取列表首项、其他应用或普通 Codex 额度代替。

## 核查结果

核查日期：2026-10-03。仅使用只读 GET，未生成模型响应，未刷新或改写授权凭据。

| 凭据与请求 | 实测结果 |
|---|---|
| Pi 新版 `openai` OAuth → `api.openai.com/v1/models` | 200，确认 token 有效 |
| 当前 Codex OAuth → `chatgpt.com/api/codex/usage` | 403，未获得共享额度 |
| 同一新 token → `chatgpt.com/backend-api/wham/usage` | 401，`no_matching_rule`；加入 `OAI-App-Brand: chatgpt` 后仍失败 |
| 同一新 token → `api.openai.com/v1/usage` | 401，`invalid_api_key` |
| 同一新 token → `api.openai.com/api/codex/usage` | 404 |
| 同一新 token → `api.openai.com/v1/api/codex/usage` | 404 |
| 当前 Codex OAuth → WHAM，分别使用 `chatgpt`、`codex` 和不设置品牌头 | 均为 200，包含 `rate_limit`，但均无 `chatpass` |
| 当前 Codex OAuth → `/backend-api/wham/usage/chatpass/apps` | 200，唯一匹配 Pi 应用，5 小时已用 10%、周已用 2% |

当前默认凭据与 `~/.codex/auth.json` 的 token、账号相同，且 token 未过期；品牌头切换未改变结果。原先“实测包含 `chatpass.windows`”的结论未能复现，不能作为已验证支持的依据。缺字段的服务端原因尚不明确，不能直接判定为未开通或额度耗尽。

此前只查询普通 WHAM 响应，遗漏应用专用接口，是 `openai·apps` 未显示的直接原因。新版 Pi token 仅在本地用于匹配注册应用，绝不发送给 ChatGPT 后端；所有用量 GET 均使用 legacy / Codex 凭据，不刷新、不改写授权。仅有新 token 时，仍提示补充 Codex 授权或打开 ChatGPT Usage。应用匹配只证明该注册存在于 Codex 凭据关联的账号，不能把本地 JWT 解码当作独立的身份签名验证。

## 官方源码核查

参考 `openai/codex` 提交 `820f85cf597b492adc6149759a22e71c72b01afa`：

- [请求路径](https://github.com/openai/codex/blob/820f85cf597b492adc6149759a22e71c72b01afa/codex-rs/backend-client/src/client/rate_limit_resets.rs)：`get_rate_limit_status()` 发起 GET；ChatGPT 后端使用 `/wham/usage`，其他 Codex 后端使用 `/api/codex/usage`，不是让新版 Pi token 查询 `api.openai.com` 的这两个路径。
- [响应结构](https://github.com/openai/codex/blob/820f85cf597b492adc6149759a22e71c72b01afa/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs)：`RateLimitStatusPayload` 定义了 `rate_limit`、`additional_rate_limits`、`credits` 等字段，没有 `chatpass`。官方 CLI 结构不能证明共享额度接口可用。
- [app-server 入口](https://github.com/openai/codex/blob/820f85cf597b492adc6149759a22e71c72b01afa/codex-rs/app-server/src/request_processors/account_processor.rs)：`get_account_rate_limits_response()` 要求 `auth.uses_codex_backend()`，再调用上述客户端；不能把任意新版 OAuth token 当作 Codex 后端凭据。
- [额度映射](https://github.com/openai/codex/blob/820f85cf597b492adc6149759a22e71c72b01afa/codex-rs/backend-client/src/client.rs)：官方分别映射普通及 `additional_rate_limits`，没有把普通 Codex 窗口复制为 ChatPass 额度。当前真实响应的 `additional_rate_limits` 为 `null`，`model_usage` 仅返回模型可用性，不是共享额度百分比。

官方 CLI 没有暴露应用专用接口，不应据此断言该接口不存在。应用查询实现参考下列开源扩展，并通过当前账号只读请求验证；不会复制普通额度来补造应用额度。

## 文档依据

- [Pi Subscription Usage](https://github.com/specode/pi-subscription-usage)：`src/query.ts` 使用 Codex 凭据查询 `/usage/chatpass/apps`；`src/providers/openai.ts` 按 `client_id` 唯一匹配应用，明确区分计划额度、应用额度和配置上限。
- [OpenAI 新授权推理接口](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：新 token 用于 `api.openai.com/v1`；明确不应指向 ChatGPT `backend-api`。
- [OpenAI 用量界面指南](https://developers.openai.com/siwc/ui-ux-guidelines)：引导用户在 ChatGPT Usage 查看和管理计划及应用上限。
- [ChatPass 窗口结构调查](https://runtimewire.com/article/openai-is-building-subscription-sharing-for-ai-apps)：描述可选的 `chatpass.windows`；文章明确说明示例为合成数据，测试账号未返回该字段，且与外部应用授权的对应关系尚未确认。
