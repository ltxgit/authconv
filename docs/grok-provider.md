# Grok / xAI 凭证规则

本文档拥有 authconv 的 xAI/Grok 输入识别、OAuth 字段和专属输出规则。通用解析、provider 判定、格式适用性、去重、文件命名和 CLI 行为见 [conversion-rules.md](conversion-rules.md)。

## 支持的凭证结构

- xAI OIDC token bundle：`access_token`、`refresh_token`，以及可选的 `id_token`、`expires_in`。
- Grok CLI `~/.grok/auth.json`：顶层为 issuer key，entry 的 `key` 保存 access token。
- CLIProxyAPI xAI JSON：`type: "xai"`。
- Sub2API Grok 账号：`platform: "grok"`。

authconv 不接受 SSO Cookie，不执行 Device Flow、浏览器授权、token 刷新或在线有效性检查，也不复制 `device_response`、`user_code`、`mint_method` 等一次性授权上下文。

## Grok CLI OAuth 常量

参考项目使用以下公共 OAuth 配置：

```text
issuer: https://auth.x.ai
client_id: b1a00492-073a-47ea-816f-4c329264a828
token_endpoint: https://auth.x.ai/oauth2/token
redirect_uri: http://127.0.0.1:56121/callback
```

输入显式携带 client ID 时原样保留。CPA 与 Sub2API 缺失时不重复生成，由消费端使用自身默认值；Grok CLI map key 必须包含 client ID，因此该格式缺失时使用公共客户端 ID。非默认 client ID 不告警，也不阻止输出。

authconv 不为 CPA 或 Sub2API 生成缺失的 OAuth 运行参数。已经过期只是状态，不产生诊断。

## xAI 字段映射

| 归一化字段 | 输入或 JWT 来源 | 输出用途 |
|---|---|---|
| `access_token` | `access_token`，或 Grok entry `key` | CPA、Sub2API、Grok / Grok2API entry `key` |
| `refresh_token` | `refresh_token` | CPA、Sub2API、Grok / Grok2API entry |
| `id_token` | `id_token` | CPA 与 Sub2API；Grok CLI 与 Grok2API auth map 不写 |
| `user_id` | `user_id` / `userId` / `sub`、JWT `sub` | CPA `sub`、Sub2API credentials、Grok / Grok2API entry 与 Grok2API map key |
| `principal_id` | `principal_id` / `principalId` | `user_id` 缺失时作为 Grok / Grok2API principal |
| `principal_type` | `principal_type` / `principalType` | Grok / Grok2API entry；缺失时使用 `User` |
| `issuer` | `oidc_issuer` / `issuer` / JWT `iss` | provider 证据与 Grok / Grok2API `oidc_issuer` |
| `client_id` | `oidc_client_id` / `client_id` / Grok map key / access token JWT `client_id` | Sub2API、Grok CLI key、Grok / Grok2API entry；CPA 使用自身配置 |
| `token_type` | `token_type` / `tokenType` | 输入存在时搬运到 CPA |
| `expires_in` | `expires_in` / `expiresIn` | 输入存在时搬运到 CPA |
| `expires_at` | `expires_at` / `expired`、JWT `exp` | CPA、Sub2API、Grok / Grok2API entry 与 UI 状态 |
| `create_time` | `create_time` / JWT `iat` | Grok / Grok2API entry |
| `base_url` | `base_url` / `baseUrl` | CPA 与 Sub2API；不作为 provider 证据 |
| `token_endpoint` | `token_endpoint` / `tokenEndpoint` | provider 证据与 CPA |
| `redirect_uri` | `redirect_uri` / `redirectUri` | CPA |
| `headers` | 输入 `headers` | 仅在 CPA 输入已携带时原样搬运 |

xAI 不解析 OpenAI 的 account、workspace、plan 或 profile claims，也不生成 synthetic `id_token`。非默认 client ID 本身不告警，也不因是否等于 Grok CLI 公共 client ID 而被拒绝。xAI access token 离线验真要求 JWT Header 的 `typ` 为 `at+jwt`，因此放入 `access_token` 字段的 ID token 或缺少该类型标记的 token 会判为伪造；不校验 audience，client ID 只作为普通字段搬运。通用验真状态与关闭方式由[通用转换规则](conversion-rules.md#access-token-离线验真)统一定义。

## CPA 与 Sub2API 输出

CPA xAI 固定写入 `type: "xai"`，其余 token、过期信息、email、sub、运行 endpoint、redirect URI、disabled 和 headers 只在输入或 JWT 已提供时搬运。CPA 自行补充请求头、默认 API base URL、OAuth client ID，并在缺少 token endpoint 时执行 OIDC discovery，authconv 不重复写入这些默认值。

Sub2API 固定使用 `platform: "grok"`、`type: "oauth"`。credentials 搬运 token、email、user ID、client ID、base URL 和过期时间；缺失的 client ID、base URL 和请求头由 Sub2API 自身处理，authconv 不生成。信封、优先级和聚合规则由通用转换合同定义。

## Grok CLI auth.json

entry 搬运：

- `key`
- `auth_mode`
- `create_time`
- `user_id`
- `email`
- `principal_type`
- `principal_id`
- `refresh_token`
- `expires_at`
- `oidc_issuer`
- `oidc_client_id`

不写 `id_token`。

标准 map key：

```text
issuer::client_id
```

官方 Grok CLI 只识别这个标准 slot；给 key 追加 user ID 不会创建第二个可登录账号，同一个 map 中重复标准 key 只会互相覆盖。因此 `grok` 固定为 single，多账号时每账号输出一份文件。

## Grok2API auth map

Grok2API entry 与上面的 Grok CLI entry 使用相同字段，但 `grok2api` 固定输出一个包含全部账号的 merged map。每个账号的原生 key 为：

```text
issuer::user_id
```

缺少 `user_id` 时使用 `principal_id`。两者都缺失时，authconv 根据账号携带的 token 生成稳定的 `authconv-<fingerprint>` 作为 Grok2API 专用 `user_id`、`principal_id` 和 map key 后缀，避免多个匿名账号因共享 client ID 被静默覆盖。Grok2API 遍历所有顶层 entry，并从 entry 的 `key` 读取 access token；authconv 不再生成官方 Grok CLI 不识别的 `issuer::client_id::user_id` 三段 key。

merged JSON 中多个凭证映射到同一 Grok2API key 时，只在该格式的输出清单中保留后项，账号数、文件名和进度均按保留后的实际数量计算。AccountStore、JSONL 和其他输出格式不受这项投影规则影响。

## 输出边界

xAI 可输出 CPA、Sub2API、Grok CLI 和 Grok2API。OpenAI 专属的 codex2api、Codex-Manager 和 Codex auth.json 不接收 xAI 账号。无法证明平台的 unknown 账号不进入任何 renderer。
