# authconv 转换规则

这份文档描述当前转换管道怎么处理输入、补字段、生成 synthetic `id_token`，以及渲染各目标格式。它只写已经实现的行为。

## 转换流程

`authconv` 的转换链路是：解析输入，识别格式，抽取账号候选，归一化字段，去重，渲染目标格式，最后按输出模式写文件或输出到 stdout。

输入内容支持单个 JSON、JSONL，以及连续拼接的多个完整 JSON 文档。输入路径是目录时，只读取目录一级的 `.json` / `.jsonl` 文件，不递归。

## 输入识别

当前会自动识别这些输入：

| 输入格式 | 识别依据 |
|---|---|
| ChatGPT Session | 顶层有 `accessToken`，并且有 `user`、`account` 或 `sessionToken`。 |
| sub2api | 顶层有 `accounts[]`，账号里有 `credentials` 或 `platform`；也支持单个 sub2api 账号对象。 |
| CPA | `type` 是 `codex`，并且有 token 字段。 |
| Codex `auth.json` | `auth_mode` 是 `chatgpt`，并且有 `tokens`。 |
| Codex-Manager | 顶层有 `tokens` 和 `meta`。 |
| codex2api | 自动识别单账号对象时要求同时有 `refresh_token` 和 `session_token`，且不是 `credentials`、`tokens`、`accounts` 或 CPA 结构；手动指定输入格式时可从任意 token 字段抽取账号。 |

数组输入会逐项识别。sub2api 的聚合结构会从 `accounts[]` 里抽账号；其他数组会按单账号列表处理。

## 归一化字段

归一化时会收集顶层字段，以及 `credentials`、`tokens`、`account`、`providerSpecificData`、`meta`、`user` 里的字段。`account.id` 会映射成账号 ID，`user.id` 会映射成用户 ID，便于后续统一处理。

`access_token` 和 `id_token` 会在本地解 JWT payload，不联网，也不验签。`https://api.openai.com/auth` 是 JWT claim 名，不是请求地址。

## 字段补全和覆盖

ChatGPT Session 和 Codex `auth.json` 输入比较特殊：能从 JWT 推导的身份字段优先用 claims，顺序是 `access_token` 再 `id_token`，最后才读输入 JSON。这样可以避免 JSON 里的旧字段覆盖当前 `access_token` 实际授权信息。

CPA、sub2api、codex2api、Codex-Manager 输入会先保留原 JSON 字段，字段缺失时才从 JWT claims 补。

Session / Codex 输入如果发现 JSON 字段和 `access_token` claim 不一致，会按字段聚合成一条 warning，比如：`session.json: access_token claim 不一致，覆盖字段: account_id,user_id,chatgpt_user_id,chatgpt_account_user_id,issuer,plan_type,email,name,workspace_id,expires_at,last_refresh`。具体字段来源和优先级见下方完整表。

普通 Session 样例：有些 ChatGPT Session 文件里，文件名末尾的账号 UUID、JSON 里的 `account.id`、`access_token` payload 里的 `https://api.openai.com/auth.chatgpt_account_id` 是一致的。以这类输入为例，转换结果中的 `account_id` 会来自同一个账号值，不会发生覆盖冲突。如果以后遇到 JSON 字段和 JWT claims 不一致的 Session，当前规则仍然优先使用 `access_token` 里的 claim。

归档 Session 里有更典型的冲突样例：部分文件的文件名账号 UUID 和 `access_token` claim 一致，但 JSON `account.id` 仍是另一个账号，`account.planType` 也可能还是 `free`。比如某条归档 Session 的值是：

| 来源 | account_id 前缀 | plan |
|---|---|---|
| 文件名 | `eb6642e8-b4a...` | - |
| JSON `account.id` / `account.planType` | `5efbb424-6c9...` | `free` |
| `access_token` 的 OpenAI auth claim | `eb6642e8-b4a...` | `k12` |

这种情况下，转换结果以 `access_token` claim 里的账号和套餐为准。真正发请求时用的是 `access_token`，它的 claim 才代表当前凭证实际授权到哪个 ChatGPT 账号。

| 归一化字段 | 输入字段 | JWT 来源 | 当前规则 |
|---|---|---|---|
| `access_token` / `refresh_token` / `session_token` | `access_token` / `accessToken`，`refresh_token` / `refreshToken`，`session_token` / `sessionToken` | 不从 JWT 补 | 只取输入里的真实 token，缺失就保持缺失并给 warning。 |
| `id_token` | `id_token` / `idToken` | 不从 JWT 还原 | 输入有真实 `id_token` 就保留；输入缺失但能推导身份时，默认尝试生成 synthetic `id_token`。 |
| `account_id` / `chatgpt_account_id` | `account_id` / `accountId`、`chatgpt_account_id` / `chatgptAccountId`、`account.id` | `https://api.openai.com/auth.chatgpt_account_id`、`https://api.openai.com/auth.chatgpt_account_user_id` 拆出的账号段，以及顶层 `chatgpt_account_id` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `chatgpt_user_id` | `chatgpt_user_id` / `chatgptUserId`、`user.id` | `https://api.openai.com/auth.chatgpt_user_id`、`https://api.openai.com/auth.user_id`、`https://api.openai.com/auth.chatgpt_account_user_id` 拆出的用户段，以及顶层 `chatgpt_user_id` / `sub` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `chatgpt_account_user_id` | `chatgpt_account_user_id` / `chatgptAccountUserId` | `https://api.openai.com/auth.chatgpt_account_user_id` | Session / Codex 输入先读 claims；缺失时由 `chatgpt_user_id + "__" + chatgpt_account_id` 推导。 |
| `user_id` | `user_id` / `userId` / `sub`、`user.id` | 顶层 `sub` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `issuer` | `issuer` / `iss` | 顶层 `iss` | Session / Codex 输入先读 claims；Codex-Manager 输出的 `meta.issuer` 使用该值，缺失时仍写 `https://auth.openai.com`。 |
| `audience` | 不从输入 JSON 补 | 顶层 `aud` | 只保存归一化结果，用于校验。 |
| `client_id` | 不从输入 JSON 补 | 顶层 `client_id` | 只保存归一化结果。 |
| `scopes` | 不从输入 JSON 补 | 顶层 `scp` | 只保存归一化结果。 |
| `not_before` | 不从输入 JSON 补 | 顶层 `nbf` | 只保存归一化结果，用于校验。 |
| `plan_type` | `plan_type` / `planType`、`chatgpt_plan_type` / `chatgptPlanType`、`account.planType` | `https://api.openai.com/auth.chatgpt_plan_type` / `plan_type`，以及顶层 `chatgpt_plan_type` / `plan_type` | 优先级同 `account_id`。 |
| `email` | `email` / `email_address` / `emailAddress`、`user.email` | 顶层 `email`，以及 `https://api.openai.com/profile.email` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `name` | `name` / `label`、`user.name` | 顶层 `name`，以及 `https://api.openai.com/profile.name` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `workspace_id` | `workspace_id` / `workspaceId`、`account.workspaceId`、`meta.workspace_id` | 顶层 `workspace_id`，以及 `https://api.openai.com/auth.workspace_id` | Session / Codex 输入先读 claims；其他格式先保留原字段。 |
| `expires_at` / `expired` | `expires_at` / `expiresAt` / `expired` / `expires` | `exp` | Session / Codex 输入先读 claims；其他格式先保留原字段。CPA 和 Codex `auth.json` 输入里的原始时间字符串会原样保留，其他输入会尽量转成 ISO 时间。 |
| `last_refresh` | `last_refresh` / `lastRefresh` | `iat` | Session / Codex 输入先读 claims；其他格式先保留原字段。目标格式需要 `last_refresh` 但输入和 JWT 都缺失时，渲染阶段会写当前时间。 |

真实的 `access_token`、`refresh_token`、`session_token`、`id_token` 不能从另一个 JWT 还原。`disabled`、`status`、`type` 这类目标格式控制字段按渲染器固定规则输出，不从 JWT claims 推导。

JWT 里有但当前目标格式没有承接字段的 claims 不会输出，例如 `jti`、`session_id`、`email_verified`、`is_signup`、`chatgpt_compute_residency`、`pwd_auth_time`、`sl`。

`iss`、`aud`、`nbf` 还会做基本校验：`iss` 不是 `https://auth.openai.com`、`aud` 不包含 `https://api.openai.com/v1`，或 `nbf` 晚于 `exp` 时，会输出 `JWT claim 校验异常` warning。`client_id` 和 `scp` 只保存到归一化结果，不参与输出覆盖。

## synthetic id_token

输入缺少 `id_token` 时，默认会尝试从其他字段推导身份并生成 synthetic `id_token`；字段不足时不生成，只给出 warning。

生成规则：

- JWT header 使用 `alg: "none"`、`typ: "JWT"`，并带 `cpa_synthetic: true`。
- payload 会尽量写入 `exp`、`sub`、`email`、`name`、`workspace_id`，以及 `https://api.openai.com/auth` 里的 `chatgpt_account_id`、`chatgpt_plan_type`、`chatgpt_user_id`、`user_id`、`chatgpt_account_user_id`、`workspace_id`。
- 签名段是 `base64url("lanv_authconv")`，也就是 `bGFudl9hdXRoY29udg`。

这个 token 只用于满足不验签工具的 JWT 形状检查，不代表真实 OAuth 验签通过。任何真正验签的下游都应该拒绝它。

传 `--no-fake-id` 后，最终输出不包含 synthetic `id_token`；输入里已标记 `id_token_synthetic: true` 的 token 也会从输出中移除。`id_token_synthetic: true` 标记只写入 `cpa` 和 `sub2api` 输出，`codex2api`、`codexmanager`、`codex` 不写这个标记。

## 输出映射

| 输出格式 | 输出规则 |
|---|---|
| `cpa` | 输出单账号对象，固定 `type: "codex"`，写入 email、account_id、plan_type、id/access/refresh token、过期时间和 last_refresh；`disabled` 固定为 `false`。 |
| `sub2api` | 输出 `sub2api-data` 信封，账号写入 `credentials`，并在 `extra.import_source` 标记 `authconv`。默认聚合到一个文件。 |
| `codex2api` | 输出账号数组，字段名保持 codex2api 风格。默认聚合到一个文件。 |
| `codexmanager` | 输出 `tokens` 和 `meta` 两块，`meta.issuer` 优先使用 JWT `iss`，缺失时写 `https://auth.openai.com`，`tags` 包含 `authconv`。 |
| `codex` | 输出 Codex CLI `auth.json` 风格结构，`auth_mode` 固定为 `chatgpt`，`OPENAI_API_KEY` 固定为 `null`。 |

`sub2api` 和 `codex2api` 是可聚合格式，默认多账号合并；传 `--mode sub2api=single` 或 `--mode codex2api=single` 后每账号一个文件。其他格式始终每账号一个文件。

## 文件命名

单账号文件名：

```text
{prefix}_{safe(email)}_{acct12}.json
```

`safe(email)` 会把 `[^\w\-.]` 之外的字符替换成 `_`，保留字母、数字、`_`、`-` 和 `.`。缺 email 时依次回退 `name` 和 `unknown`。`acct12` 来自 `chatgpt_account_id`，没有时回退 `account_id`，只取前 12 位。

多格式输出时会给每种格式建一个子目录。聚合文件名是 `{prefix}_{账号数}-accounts.json`。JSONL 模式会强制 `sub2api` / `codex2api` 按单账号输出，再按格式聚合为 `.jsonl`，保证每行只包含一个账号。

同一批次内部命名冲突会自动追加 `-2`、`-3` 后缀。目标路径已存在时默认报错，只有显式传 `--force` 才覆盖。

## 去重

多个输入文件里出现相同账号时会去重。判断依据是归一化后的完整账号对象，忽略 `sourceName`、`sourcePath`、`warnings` 和 `inputFormat`；只要 token、身份字段、时间字段等任一有效字段不同，就会视为不同账号。重复时保留第一次读到的账号。
