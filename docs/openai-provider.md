# OpenAI / ChatGPT 凭证规则

本文档拥有 OpenAI、ChatGPT 与 Codex 专属的输入识别、JWT claims、字段优先级、synthetic `id_token` 和输出字段规则。通用解析、provider 判定、去重、格式适用性和文件命名见 [conversion-rules.md](conversion-rules.md)。

## 支持的输入结构

| 输入格式 | 识别依据 |
|---|---|
| ChatGPT Session | 顶层有 `accessToken`，并且有 `user`、`account` 或 `sessionToken`。 |
| CPA OpenAI | `type: "codex"`，并且有 token 字段。 |
| Codex `auth.json` | `auth_mode: "chatgpt"`，并且有 `tokens`。 |
| Codex-Manager | 顶层有 `tokens` 和 `meta`。 |
| codex2api | 自动识别单账号对象时要求是扁平 token 对象，并且至少有 `refresh_token`、`session_token` 或 `id_token` 之一；不能带其他格式的结构特征。手动指定输入格式时可从任意 token 字段抽取账号。 |
| Sub2API OpenAI | 账号项显式使用 `platform: "openai"`。 |

OpenAI provider 证据还包括 `https://auth.openai.com` JWT issuer，以及明确的 OpenAI account/chatgpt 字段。只有 opaque token、email 或 name 时不能证明平台，账号保持 unknown。

## 字段优先级

ChatGPT Session 和 Codex `auth.json` 以当前 token claims 为准，顺序是 `access_token`、`id_token`、输入 JSON。这样能避免旧的 Session 或 auth.json metadata 覆盖当前 token 实际授权的账号。

CPA、Sub2API、codex2api 和 Codex-Manager 先保留输入 JSON 字段，缺失时再从 JWT claims 补齐。

Session / Codex 输入发现 JSON 与 `access_token` claims 不一致时，直接使用上述优先级，不产生诊断。

## OpenAI 字段映射

| 归一化字段 | 输入字段 | JWT 来源 |
|---|---|---|
| `account_id` / `chatgpt_account_id` | `account_id` / `accountId`、`chatgpt_account_id` / `chatgptAccountId`、`account.id` | `https://api.openai.com/auth.chatgpt_account_id`、`chatgpt_account_user_id` 的账号段、顶层 `chatgpt_account_id` |
| `chatgpt_user_id` | `chatgpt_user_id` / `chatgptUserId`、`user.id` | `https://api.openai.com/auth.chatgpt_user_id`、`user_id`、`chatgpt_account_user_id` 的用户段、顶层 `sub` |
| `chatgpt_account_user_id` | `chatgpt_account_user_id` / `chatgptAccountUserId` | `https://api.openai.com/auth.chatgpt_account_user_id`；缺失时可由 user ID 与 account ID 拼接 |
| `workspace_id` | `workspace_id` / `workspaceId`、`account.workspaceId`、`meta.workspace_id` | 顶层或 OpenAI auth claim 中的 `workspace_id` |
| `plan_type` | `plan_type` / `planType`、`chatgpt_plan_type` / `chatgptPlanType`、`account.planType` | `https://api.openai.com/auth.chatgpt_plan_type` / `plan_type` |
| `email` | `email` / `email_address` / `emailAddress`、`user.email` | 顶层 `email`、`https://api.openai.com/profile.email` |
| `name` | `name` / `label`、`user.name` | 顶层 `name`、`https://api.openai.com/profile.name` |
| `issuer` | `issuer` / `iss` | 顶层 `iss`；Codex-Manager 缺失时输出 `https://auth.openai.com` |
| `expires_at` | `expires_at` / `expiresAt` / `expired` / `expires` | `exp` |
| `last_refresh` | `last_refresh` / `lastRefresh` | `iat` |

`https://api.openai.com/auth` 是 JWT claim 名，不是请求地址。JWT claims 只在本地解码并用于归一化；默认 access token 离线验真、状态、过期边界和关闭方式由[通用转换规则](conversion-rules.md#access-token-离线验真)统一定义。凭证已经过期仍只作为状态展示，不改变签名真实性。

## Session 字段冲突

归档 Session 可能出现 JSON `account.id`、套餐与 `access_token` claims 不一致。例如文件和 token 指向账号 A，但 JSON 仍保存账号 B 的旧 metadata。authconv 选择 `access_token` claims，因为真实请求由该 token 决定授权账号。

这条优先级适用于 account、user、plan、workspace、email、name、expires 和 last refresh，不按文件名或旧 JSON 猜测当前授权身份。

## synthetic id_token

输入缺少 `id_token`，但能够推导 OpenAI 身份时，默认生成标记为 synthetic 的 JWT：

- header 使用 `alg: "none"`、`typ: "JWT"`、`cpa_synthetic: true`。
- payload 搬运 `exp`、`sub`、email、name、workspace，以及 OpenAI auth claim 中的 account、plan 和 user 字段。
- 签名段固定为 `base64url("lanv_authconv")`。

synthetic token 只满足不验签工具的 JWT 形状检查，不代表真实 OAuth 验签通过。字段不足时不生成，也不额外告警。

使用 `--no-fake-id` 时，所有输出都移除 synthetic `id_token`。`id_token_synthetic: true` 只写入 CPA 和 Sub2API；codex2api、Codex-Manager 和 Codex auth.json 不写该标记。

## OpenAI 输出字段

- CPA：`type: "codex"`，写入 email、account ID、plan、id/access/refresh/session token、过期时间、last refresh 和 disabled。
- Sub2API：账号使用 `platform: "openai"`、`type: "oauth"`，token 和 OpenAI 身份字段写入 `credentials`。
- codex2api：输出扁平账号数组，使用 codex2api 字段名。
- Codex-Manager：输出 `tokens` 与 `meta`；meta 包含 label、issuer、workspace、account ID 和 `authconv` tag。
- Codex auth.json：输出 `auth_mode: "chatgpt"`、`OPENAI_API_KEY: null`、`tokens` 和 `last_refresh`。

OpenAI 不输出 Grok CLI auth.json 或 Grok2API auth map。
