# JSON API

`ai-quota serve` 提供只读 HTTP API，凭据仍从本机配置和环境变量读取。

## 启动

```bash
ai-quota serve                         # 127.0.0.1:8787

export AI_QUOTA_API_TOKEN="$(openssl rand -hex 32)"
ai-quota serve --host 0.0.0.0          # 非本机监听必须设置 token
```

浏览器跨域访问时，显式指定来源：

```bash
ai-quota serve --cors-origin https://quota.example.com
```

远程访问应置于 Tailscale、HTTPS 反向代理或其他可信网络内，勿将明文 HTTP 直接暴露到公网。

## 接口

```text
GET /api/v1/health
GET /api/v1/quotas
GET /api/v1/quotas?providers=openai,claude
GET /api/v1/codex/reset-cards
```

未指定 `providers` 时，查询 `ai-quota auth` 中启用的全部 provider。配置 token 后：

```bash
curl -H "Authorization: Bearer $AI_QUOTA_API_TOKEN" \
  'http://127.0.0.1:8787/api/v1/quotas?providers=openai,claude'
```

## 响应

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-26T03:00:00.000Z",
  "status": "partial",
  "providers": [
    {
      "provider": "openai",
      "status": "ok",
      "models": [
        {
          "name": "codex · plus",
          "windows": {
            "short": {
              "remainingPercent": 84,
              "usedPercent": 16,
              "resetsAt": "2026-07-26T07:00:00.000Z",
              "resetsInMs": 14400000,
              "status": "available"
            },
            "weekly": {
              "remainingPercent": 62,
              "usedPercent": 38,
              "resetsAt": "2026-07-30T00:00:00.000Z",
              "resetsInMs": 334800000,
              "status": "available"
            }
          }
        }
      ]
    },
    {
      "provider": "claude",
      "status": "error",
      "error": {
        "code": "auth",
        "message": "credentials missing",
        "retryable": false
      }
    }
  ]
}
```

Codex 重置卡：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-26T03:00:00.000Z",
  "provider": "openai",
  "status": "ok",
  "availableCount": 1,
  "credits": [
    {
      "status": "available",
      "title": "Rate limit reset",
      "grantedAt": "2026-07-25T00:00:00.000Z",
      "expiresAt": "2026-08-01T00:00:00.000Z"
    }
  ]
}
```

约定：

- `status`：`ok`、`partial` 或 `error`；单个 provider 失败不影响其他结果。
- 百分比范围为 `0–100`；时间为 UTC ISO 8601；时长单位为毫秒。
- API 始终返回当前快照，不缓存响应。
- `/api/v1` 内只新增可选字段；删除字段或改变语义时升级 API 版本。
