# Grok / xAI 凭证规则

本文档拥有 authconv 的 xAI/Grok 输入识别、OAuth 字段和专属输出规则。通用解析、provider 冲突、格式适用性、去重、文件命名和 CLI 行为见 [conversion-rules.md](conversion-rules.md)。

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

authconv 不为 CPA 或 Sub2API 生成缺失的 OAuth 运行参数。已经过期只是状态，不产生 warning。

## xAI 字段映射

| 归一化字段 | 输入或 JWT 来源 | 输出用途 |
|---|---|---|
| `access_token` | `access_token`，或 Grok entry `key` | CPA、Sub2API、Grok entry `key` |
| `refresh_token` | `refresh_token` | CPA、Sub2API、Grok entry |
| `id_token` | `id_token` | CPA 与 Sub2API；Grok auth.json 不写 |
| `user_id` | `user_id` / `userId` / `sub`、JWT `sub` | CPA `sub`、Sub2API credentials、Grok entry |
| `principal_id` | `principal_id` / `principalId` | `user_id` 缺失时作为 Grok principal |
| `principal_type` | `principal_type` / `principalType` | Grok entry；缺失时使用 `User` |
| `issuer` | `oidc_issuer` / `issuer` / JWT `iss` | provider 证据与 Grok `oidc_issuer` |
| `client_id` | `oidc_client_id` / `client_id` / JWT `client_id` | Sub2API、Grok key 与 entry；CPA 使用自身配置 |
| `token_type` | `token_type` / `tokenType` | 输入存在时搬运到 CPA |
| `expires_in` | `expires_in` / `expiresIn` | 输入存在时搬运到 CPA |
| `expires_at` | `expires_at` / `expired`、JWT `exp` | CPA、Sub2API、Grok entry 与 UI 状态 |
| `create_time` | `create_time` / JWT `iat` | Grok entry |
| `base_url` | `base_url` / `baseUrl` | CPA 与 Sub2API；不作为 provider 证据 |
| `token_endpoint` | `token_endpoint` / `tokenEndpoint` | provider 证据与 CPA |
| `redirect_uri` | `redirect_uri` / `redirectUri` | CPA |
| `headers` | 输入 `headers` | 仅在 CPA 输入已携带时原样搬运 |

xAI 不解析 OpenAI 的 account、workspace、plan 或 profile claims，也不生成 synthetic `id_token`。JWT audience 只保存为 metadata，不因非默认 client ID 或 audience 拒绝 xAI 凭证。

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
单账号：issuer::client_id
多账号：issuer::client_id::user_id
```

多账号 key 规则来自参考实现 `sso2auth.py`。authconv 在 renderer 前按 xAI `user_id/principal_id` 去重，不扩展第四段 key，也不静默追加无协议依据的摘要。

## 输出边界

xAI 可输出 CPA、Sub2API 和 Grok CLI。OpenAI 专属的 codex2api、Codex-Manager 和 Codex auth.json 不接收 xAI 账号。无法证明平台的 unknown 账号不进入任何 renderer。
