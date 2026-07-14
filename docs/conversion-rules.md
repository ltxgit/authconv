# authconv 通用转换规则

本文档是跨 provider 转换合同的唯一来源，只描述输入容器、provider 判定、通用字段、格式适用性、输出模式、文件命名和去重。

Provider 专属规则分别见：

- [OpenAI / ChatGPT 凭证规则](openai-provider.md)
- [Grok / xAI 凭证规则](grok-provider.md)

## 转换流程

```text
解析输入 → 抽取候选 → 判定 provider → 归一化字段 → 去重 → 过滤适用格式 → 渲染 → 命名与序列化
```

输入文本支持单个 JSON、JSONL，以及连续拼接的多个完整 JSON 文档。输入路径还支持 `.zip` 文件；目录输入只读取一级 `.json`、`.jsonl`、`.zip` 文件，不递归。ZIP 只读取 JSON/JSONL，并忽略 `__MACOSX` 和隐藏路径段。

数组输入逐项识别。Sub2API 聚合结构从 `accounts[]` 抽取账号；CPA、Codex、Grok CLI 和其他账号数组按各自结构抽取。

具体 OpenAI 与 xAI 输入形状由各 provider 文档拥有，本文件不重复字段级识别表。

## Provider 判定

Provider 只能来自明确证据：

1. 输入结构中的 `type`、`platform`、Grok issuer-key 或目标格式特征。
2. `access_token` 和 `id_token` 可解码 JWT 的 `iss`。
3. `oidc_issuer`、`issuer`。
4. 精确匹配的已知 `token_endpoint`。

`base_url`、email、name 和单独的 opaque token 不作为 provider 证据。

OpenAI 与 xAI 证据冲突时，该候选不生成账号，并产生拒绝诊断。无法证明平台时保留为 `unknown`；unknown 可以检查和展示，但不参与任何格式输出。

JWT 只在本地解码 Header/Payload，不联网、不验签。真实 `access_token`、`refresh_token`、`session_token` 和 `id_token` 不能从另一个 JWT 还原。

## 通用归一化字段

归一化会读取顶层字段，以及 `credentials`、`tokens`、`account`、`providerSpecificData`、`meta`、`user` 等已知容器。

| 归一化字段 | 输入或 JWT 来源 | 通用规则 |
|---|---|---|
| `access_token` | `access_token` / `accessToken` / Grok entry `key` | 只搬运真实输入，缺失不补。 |
| `refresh_token` | `refresh_token` / `refreshToken` | 只搬运真实输入，缺失不补。 |
| `session_token` | `session_token` / `sessionToken` | 只搬运真实输入，缺失不补。 |
| `id_token` | `id_token` / `idToken` | 真实 token 原样保留；OpenAI synthetic 规则见 provider 文档。 |
| `user_id` | `user_id` / `userId` / `sub` | 输入字段优先级由 provider 文档定义。 |
| `issuer` | `issuer` / `iss` / JWT `iss` | 用于 provider 证据和输出 metadata。 |
| `audience` | JWT `aud` | 保存为身份 metadata；校验规则由 provider 定义。 |
| `client_id` | `client_id` / `clientId` / `oidc_client_id` / JWT `client_id` | 输入值原样保留；目标消费端已有默认值时不重复生成。 |
| `scopes` | JWT `scp` / `scope` | 保存到归一化账号，不伪造 scope。 |
| `email` / `name` | 输入字段或 JWT 标准 claims | provider 文档定义结构字段与 claim 优先级。 |
| `expires_at` | `expires_at` / `expiresAt` / `expired` / `expires` / JWT `exp` | 已有合法值用于输出和 UI；无法解析时 warning，已经过期不 warning。 |
| `last_refresh` / `issued_at` | `last_refresh` / `lastRefresh` / JWT `iat` | 按 provider 输出规则处理；xAI 缺失时不生成当前时间。 |

`disabled`、`status`、目标 `type` 等控制字段由 renderer 按目标格式写入，不从 JWT claims 推导。未知额外字段不会穿透 renderer。

`refresh_token` 默认参与所有适用格式的输出。CLI 使用 `--no-refresh-token`，或在 Web 关闭“包含 refresh_token”后，renderer 会从全部输出中省略该字段；归一化账号仍保留原始值，识别、合并和去重行为不变。该裁剪不产生 warning，也不阻止仅含 refresh token 的账号继续渲染。

## 诊断行为

- 缺少可识别 token：输入诊断。
- OpenAI/xAI 证据冲突：拒绝该候选。
- 输入 metadata 与高优先级 token claims 不一致：warning，并列出覆盖字段。
- JWT issuer、audience 或时间关系异常：warning。
- 过期时间无法解析：warning。
- 凭证已经过期：仅作为状态展示，不产生 warning。
- 可选 token 缺失或无法生成 synthetic token：不产生 warning。

批量输入中有候选被拒绝时，正常账号仍参与输出，CLI 返回非零。仅有部分所选格式不适用时正常输出并返回 0；所有所选格式均无产物时不创建目录或 ZIP，并返回非零。

## 格式适用性

| 输出格式 | OpenAI | xAI | unknown | 默认模式 |
|---|---:|---:|---:|---|
| CPA | 是 | 是 | 否 | single |
| Sub2API | 是 | 是 | 否 | merged |
| codex2api | 是 | 否 | 否 | merged |
| Codex-Manager | 是 | 否 | 否 | single |
| Codex auth.json | 是 | 否 | 否 | single |
| Grok CLI auth.json | 否 | 是 | 否 | merged |

CPA、Codex-Manager 和 Codex auth.json 多账号时每账号一个文件。Sub2API、codex2api 和 Grok CLI 支持 `merged` 与 `single`。

JSONL 模式会把可聚合格式按单账号渲染，再按格式写入 `.jsonl`，保证每行只包含一个账号文档。Web URL 保存 JSONL 实际生效的 single 模式。

各 provider 的目标字段见对应 provider 文档；CLI 参数和用法见 [cli.md](cli.md)。

## 文件命名

单账号文件名：

```text
{formatPrefix}_{safe(identity)}_{providerStableId12}.json
```

- `identity` 优先 email，其次 name，最后 `unknown`。
- `safe` 把 `[^\w\-.]` 之外的字符替换成 `_`。
- OpenAI 稳定 ID 使用 `chatgpt_account_id/account_id`。
- xAI 稳定 ID 使用 `user_id/principal_id`。
- 稳定 ID 只取前 12 位；缺失时省略该段。
- CPA xAI 与 OpenAI 都使用 `cpa_...`，没有 `xai-...` 特例。

多格式输出时，每种格式使用自己的子目录。多账号 merged 文件名为 `{formatPrefix}_{count}-accounts.json`。JSONL 使用相同规则并改为 `.jsonl`。

同批路径重复时追加 `-2`、`-3` 等确定性后缀。磁盘目标已存在时默认报错，只有显式 `--force` 才覆盖。

## 去重

去重只检查真实 `access_token`、`refresh_token`、`session_token` 和非 synthetic `id_token` 的直接重合关系。同一字段两边都有值时必须相等，一边缺失不算冲突；至少有一个重合且相等的凭据字段才允许合并。邮箱、名称、account ID 和 user ID 等元数据不参与去重。

只有一个既有账号组与新记录兼容时才合并。如果一条记录同时桥接两个互相冲突的账号组，不进行传递式合并，所有记录全部保留并参与输出。

OpenAI、xAI 和 unknown 不跨 provider 去重。
