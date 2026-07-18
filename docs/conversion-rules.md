# authconv 通用转换规则

本文档是跨 provider 转换合同的唯一来源，只描述输入容器、provider 判定、通用字段、格式适用性、输出模式、文件命名和去重。

Provider 专属规则分别见：

- [OpenAI / ChatGPT 凭证规则](openai-provider.md)
- [Grok / xAI 凭证规则](grok-provider.md)

## 转换流程

```text
流式解析输入 → 抽取候选 → 归一化并判定 provider → access token 离线验真 → 按来源提交并去重 → 构建输出清单 → 流式渲染与序列化
```

输入内容支持单个 JSON、JSONL、连续拼接的多个完整 JSON 文档和 ZIP。文件扩展名与 MIME 不参与识别：ZIP 由 magic bytes 识别；文本判型最多检查 64 KiB。连续的单行 JSON 记录，以及“结构已闭合的坏行或非 JSON 文本行后仍有 JSON 记录”的输入按 JSONL 解析；未闭合的首个 JSON 容器、同一行拼接的多个 root，或完整 root 后接多行 pretty root 时按普通或连续 JSON 解析。达到判型上限仍未遇到边界时，解析器按结构完整的换行记录继续处理，因此超长 JSONL 仍能隔离坏行，超长单 JSON、pretty JSON 和同一行连续 root 也保持原语义。单独的非 JSON 文本仍视为无法识别。识别阶段消费的 chunk 会原样回放给解析器，不建立第二条解析路径。

目录输入递归读取全部普通文件，再逐个按内容识别。ZIP 中的非隐藏文件也使用同一内容识别规则，并忽略 `__MACOSX` 和隐藏路径段；entry 按归档中的物理顺序处理。无法识别的文件与其他有效来源混在同一批次时静默忽略，整批都无法识别时报告不支持的输入。

JSONL 每行独立提交，坏行不影响前后合法行。连续 JSON 在首个损坏文档处停止，已经完整解析的前序文档保留。不同文件和 ZIP entry 也独立提交；一个来源失败不会撤销其他有效来源。

数组输入逐项识别。Sub2API 聚合结构从 `accounts[]` 抽取账号；CPA、Codex、Grok CLI 和其他账号数组按各自结构抽取。

具体 OpenAI 与 xAI 输入形状由各 provider 文档拥有，本文件不重复字段级识别表。

## Provider 判定

Provider 按以下顺序确定：

1. 已识别的 CPA 结构；其显式 `type` 合同优先于同时携带的 issuer 或 token endpoint metadata。
2. 非 CPA flat 结构中的显式 xAI 证据：`platform: "grok"`、`type: "xai"`、xAI issuer 或精确的 xAI `token_endpoint`。这些证据先于通用 ChatGPT Session shape。
3. 其他已识别的输入结构：Grok CLI、ChatGPT Session、Codex、Codex-Manager 和 codex2api。
4. 其他结构字段：`platform`、`type`、Grok issuer-key、`oidc_issuer` / `issuer`、精确匹配的已知 `token_endpoint`，以及明确的 OpenAI account 字段。
5. 结构仍未知时，依次尝试 `access_token`、`id_token` JWT 的 `iss`。
6. 仍无明确证据时保留为 `unknown`。

已识别结构和显式结构字段优先于 JWT issuer，两者不一致时不拒绝也不产生诊断。`base_url`、client ID、email、name 和单独的 opaque token 不作为 provider 证据。unknown 可以检查和展示，但不参与任何格式输出。

Provider 判定和字段抽取只在本地解码 JWT Header/Payload；无法解码的值按普通 token 搬运，不产生输入诊断。解码不代表 token 真实，默认验真由后续独立步骤完成。真实 `access_token`、`refresh_token`、`session_token` 和 `id_token` 不能从另一个 JWT 还原。

## Access token 离线验真

authconv 默认使用仓库内固定的 OpenAI / xAI JWKS 快照验证 `access_token`，运行时不执行 discovery、不下载密钥，也不读取 token 的 `jku`、`x5u` 或内嵌 JWK。验证发生在 provider 确定之后、AccountStore 去重之前：

| Provider | 固定 issuer | 算法与公钥 | audience 合同 |
|---|---|---|---|
| OpenAI | `https://auth.openai.com` | RS256 / RSA | 必须包含 `https://api.openai.com/v1` |
| xAI | `https://auth.x.ai` | ES256 / P-256 | 不校验 `aud`；client ID 不参与验真 |

验证状态只有四种：

- `verified`：签名、issuer 和 provider 适用的 audience 合同均通过；xAI 没有 audience 合同。
- `forged`：JWT 损坏、算法不允许、签名失败、issuer 不匹配，或 OpenAI audience 不匹配。
- `unverifiable`：缺少 access token、token 不是 JWT、provider 未知，或内置 JWKS 没有对应 `kid`。
- `unchecked`：用户显式关闭验真，未执行密码学判断。

默认输出清单只接收 `verified` 账号。CLI 使用 `--no-verify-token`、Web 关闭“验证 token 真伪”后，输出恢复为字段搬运；该开关不把伪造或不可验证状态改写为真实。Web 开启验真时，文件、文件夹和 ZIP 导入会在写入 AccountStore 前跳过 `forged`；粘贴草稿中的 `forged` 仍留在草稿列表并显示状态，但被阻止进入预览、下载或 AccountStore。`unverifiable` 无法据此判定为假，仍保留状态标记但不参与默认输出。关闭验真不会恢复导入时已经跳过的账号。再次开启时，access token 与 provider 验证合同均未变化的既有结果直接复用，只有 `unchecked`、缺失结果或上下文变化的账号重新验签。access token 验证失败时，不使用 ID token、refresh token、session token 或 synthetic ID token 替代。

Web 粘贴内容只有在最近一次解析成功后才成为活动草稿并参与预览和下载；textarea 一旦修改，Worker 立即撤销旧草稿，已加载账号重新成为活动集合，直到新内容解析成功。草稿写入 AccountStore 仍只发生在用户点击“加入列表”时。

`exp` 不改变签名真实性：签名真实但已经过期的账号仍可转换，并沿用现有过期展示。`nbf` 尚未生效保持 `verified`，同时显示独立提示。验真只能证明 token 由快照中的密钥签发且 claims 符合本地合同，不能证明 token 未撤销、账号可用或提交者拥有该账号。内置密钥轮换后出现未知 `kid` 时必须更新仓库快照，authconv 不联网、不保留旧密钥 fallback，也不自动放行。

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
| `audience` | JWT `aud` | 保存为 metadata；默认 access token 验真另按上节 provider 合同检查。 |
| `client_id` | `client_id` / `clientId` / `oidc_client_id` / Grok map key / access token JWT `client_id` | 输入值原样保留；不从 ID token 推导，目标消费端已有默认值时不重复生成。 |
| `scopes` | JWT `scp` / `scope` | 保存到归一化账号，不伪造 scope。 |
| `email` / `name` | 输入字段或 JWT 标准 claims | provider 文档定义结构字段与 claim 优先级。 |
| `expires_at` | `expires_at` / `expiresAt` / `expired` / `expires` / JWT `exp` | 输入值或合法时间用于输出和 UI；无法解析时保留文本，不产生诊断。 |
| `last_refresh` / `issued_at` | `last_refresh` / `lastRefresh` / JWT `iat` | 按 provider 输出规则处理；xAI 缺失时不生成当前时间。 |

`disabled`、`status`、目标 `type` 等控制字段由 renderer 按目标格式写入，不从 JWT claims 推导。未知额外字段不会穿透 renderer。

`refresh_token` 默认参与所有适用格式的输出。CLI 使用 `--no-refresh-token`，或在 Web 关闭“包含 refresh_token”后，renderer 会从全部输出中省略该字段；归一化账号仍保留原始值，识别、合并和去重行为不变。该裁剪不产生诊断，也不阻止仅含 refresh token 的账号继续渲染。

## 诊断行为

结构化诊断只表示某段输入被跳过：

- JSON 解析失败或 ZIP 解压失败。
- 手动指定的输入格式与内容不匹配。
- 候选没有任何可用 token。
- 整批文件都无法按内容识别。

字段优先级覆盖、JWT 无法解码、provider 差异、时间无法解析、凭证过期、可选 token 缺失和无法生成 synthetic token 都不产生输入诊断。验真失败使用独立的状态和原因汇总，不伪装成解析 warning。过期时间只有在能够按绝对时间解析时才作为过期状态展示；比较使用当前时刻，因此不依赖界面所在时区。

批量输入出现诊断时，其他正常账号仍参与输出，CLI 写出有效结果并返回非零。默认验真下，部分账号被拒绝时仍写出 `verified` 账号并返回非零；全部账号被拒绝时不创建目录、JSON、JSONL 或 ZIP。仅有部分所选格式不适用时正常输出并返回 0；所有所选格式均无产物时不创建目录或 ZIP，并返回非零。

## 格式适用性

| 输出格式 | OpenAI | xAI | unknown | 默认模式 |
|---|---:|---:|---:|---|
| CPA | 是 | 是 | 否 | single |
| Sub2API | 是 | 是 | 否 | merged |
| codex2api | 是 | 否 | 否 | merged |
| Codex-Manager | 是 | 否 | 否 | single |
| Codex auth.json | 是 | 否 | 否 | single |
| Grok CLI auth.json | 否 | 是 | 否 | single |
| Grok2API auth map | 否 | 是 | 否 | merged |

CPA、Codex-Manager、Codex auth.json 和 Grok CLI 多账号时每账号一个文件。Grok2API 始终把所有适用账号写入一个 merged map。只有 Sub2API 与 codex2api 支持在 `merged` 和 `single` 之间切换，默认均为 `merged`。

JSONL 是独立的文本模式：所有格式都按单账号渲染，再按格式写入 `.jsonl`，保证每行只包含一个账号文档。Web URL 只为 Sub2API 与 codex2api 保存 JSONL 实际生效的 single 模式。

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

ZIP 下载名为 `authconv_{basis}_{YYYYMMDDHHmmss}.zip`，时间戳使用本地时间。实际导出只有一个账号时，`basis` 使用该账号的安全 identity 与可用的稳定 ID；否则使用 `{实际导出账号数}-accounts`。账号数在 provider 适用性、验真过滤和 Grok2API key 投影之后计算。

## 去重

去重只检查真实 `access_token`、`refresh_token`、`session_token` 和非 synthetic `id_token` 的直接重合关系。同一字段两边都有值时必须相等，一边缺失不算冲突；至少有一个重合且相等的凭据字段才允许合并。邮箱、名称、account ID 和 user ID 等元数据不参与去重。

只有一个既有账号组与新记录兼容时才合并。如果一条记录同时桥接两个互相冲突的账号组，不进行传递式合并，所有记录全部保留并参与输出。

OpenAI、xAI 和 unknown 不跨 provider 去重。

access token、验真结果和验证上下文作为一个不可拆分的数据单元合并。client ID 是普通字段，不属于该单元。AccountStore 不执行验签、不选择 JWKS，也不按状态给重复账号排序。
