# authconv CLI

OpenAI / Grok OAuth 凭证格式转换工具的命令行参考。

`authconv` 把一份或多份凭证输入（ChatGPT `/api/auth/session` 响应、Codex `auth.json`、sub2api 导出、ZIP 归档、或散装 token JSON）归一化后，渲染成目标工具所需的格式（CPA / sub2api / codex2api / Codex-Manager / Codex auth.json），并写入文件或输出到 stdout。所有运算在本地完成，不发起任何网络请求。

---

## 调用方式

```bash
# 全局链接后
authconv <input...> [options]

# 或直接跑打包产物
node dist/cli.mjs <input...> [options]
```

源码安装命令：

需要 Node.js 20.19.0 或更新版本。

```bash
git clone https://github.com/ltxgit/authconv.git
cd authconv
npm ci
npm run build
npm link
```

`npm link` 会把全局命令 `authconv` 指向本项目的 `dist/cli.mjs`。不想全局链接时，在项目目录内直接运行 `node dist/cli.mjs ...` 即可。更新源码后重新执行 `npm run build`；取消全局命令用 `npm unlink -g authconv`。

命令是**纯扁平**结构：没有子命令，一切通过参数控制。`<input...>` 可以是一个或多个 JSON / JSONL / ZIP 文件或目录；从 stdin 读取时必须显式传 `--stdin`；完全无参数时显示帮助。stdin 只支持单个 JSON、JSONL，以及连续拼接的多个完整 JSON 文档；ZIP 只作为文件路径输入。`--serve` 是独立的本地 Web UI 模式，不读取输入、不写输出文件。

---

## 语法

```
authconv [<input...>] [options]
```

- 指定文件：解析文件内容，支持单个 JSON / JSONL / ZIP / 多 JSON 文档流。
- 指定目录：非递归解析目录一级的 `.json` / `.jsonl` / `.zip` 文件（按文件名排序），账号合并处理。
- 指定多个路径：按命令行顺序读取每个文件或目录，目录内部仍按文件名排序。
- 显式传 `--stdin`：从 stdin 读取 JSON / JSONL / 多 JSON 文档流，不支持二进制 ZIP。
- 完全无参数：显示帮助，不读取 stdin。
- 未指定路径且未传 `--stdin`：报错，不隐式等待 stdin。

---

## 参数

### 输入

| 参数 | 说明 |
|---|---|
| `<path...>` | 输入 JSON / JSONL / ZIP 文件或目录（位置参数），可传多个。 |
| `-i, --input <path>` | 同上的显式形式，可重复，也可和位置参数混用。 |
| `--stdin` | 显式从 stdin 读取输入。与 `<path...>` / `-i` 互斥。 |

### 输出格式

| 参数 | 说明 |
|---|---|
| `-f, --format <list>` | 输出格式，逗号分隔或重复传入。可用值：`cpa` `sub2api` `codex2api` `codexmanager` `codex` `grok` `all`。 |
| `--mode <fmt>=<m>` | 为**可聚合格式**设置产出方式，`m ∈ merged \| single`。可重复。对 `sub2api` / `codex2api` / `grok` 生效。 |

未指定 `-f` 时默认输出所有格式（`all`）。

### 输出文本

| 参数 | 说明 |
|---|---|
| `--jsonl` | JSONL 文本模式。每个账号一行，按格式聚合为 `.jsonl`。 |

JSONL 会强制可聚合格式按单账号输出，保证每行只包含一个账号：

- CPA / Codex-Manager 多账号本来会拆成多个 JSON 文件，JSONL 会变成每账号一行。
- `sub2api` / `codex2api` / `grok` 即使默认或显式设置为 `merged`，在 JSONL 下也会按账号拆行。
- 这些格式的 `merged` 设置对 JSONL 不生效；JSONL 优先。

### 输出目标

| 参数 | 说明 |
|---|---|
| `-o, --out-dir <path>` | 输出目录，**默认 `output`**。 |
| `--stdout` | 输出到 stdout。仅当最终只有单格式且单文件时可用，否则报错。 |

未指定输出目标时按 `-o output` 写盘。

### 行为

| 参数 | 说明 |
|---|---|
| `--inspect` | 只解析并打印账号摘要（邮箱 / account_id / 套餐 / 过期），**不产出任何文件**。与 `-o`/`--stdout`/`--zip`/`--dry-run` 互斥，同时指定会报错。 |
| `--dry-run` | 打印将要写入的计划；单文件显示目标路径，多文件只显示总数，不实际写盘。 |
| `--force` | 允许覆盖已存在的目标文件。默认遇到同名文件报错退出。 |
| `--no-fake-id` | 最终输出不包含 synthetic `id_token`。默认会为 synthetic `id_token` 写入非空占位签名段。 |
| `--no-refresh-token` | 从全部输出中省略 `refresh_token`。规范化与去重仍使用输入中的原始值。 |
| `--zip` | 写入一个 `.zip` 文件到输出目录，压缩包内保留当前输出目录结构。与 `--stdout` 互斥。 |
| `--serve` | 启动本地 Web UI，默认监听 `127.0.0.1:8787`。不能和输入、转换或输出参数混用。 |
| `--listen <host:port>` | 设置 Web UI 监听地址，仅与 `--serve` 一起使用。 |

### 通用

| 参数 | 说明 |
|---|---|
| `--lang <zh\|en>` | CLI 帮助、错误、摘要和 warning 的显示语言。优先使用 `--lang` / `AUTHCONV_LANG` / 系统 locale，未检测到时默认英文。 |
| `--help` | 显示帮助（输出到 stderr，stdout 保持干净供管道使用）。 |
| `--version` | 显示版本。 |

---

## 输出格式

| 格式 | 目标工具 | 结构 | 可聚合 |
|---|---|---|---|
| `cpa` | CLIProxyAPI | 文件内容为单账号对象；多账号会拆分为多个文件 | 否 |
| `sub2api` | sub2api | `sub2api-data` 信封，`accounts[]` 内联 | 是 |
| `codex2api` | codex2api | 账号数组 | 是 |
| `codexmanager` | Codex-Manager | `tokens` + `meta`，每账号一文件 | 否 |
| `codex` | Codex CLI | 原生 `auth.json`，包含 `auth_mode`、`OPENAI_API_KEY`、`tokens` 和 `last_refresh` | 否 |
| `grok` | Grok CLI | `~/.grok/auth.json` 风格结构，access token 写入 entry `key` | 是 |

规则文档按职责拆分：

- [通用转换规则](conversion-rules.md)：平台判定、诊断、格式适用性、输出模式、文件命名和去重。
- [OpenAI / ChatGPT 凭证规则](openai-provider.md)：OpenAI 输入、字段优先级、synthetic `id_token` 和专属输出字段。
- [Grok / xAI 凭证规则](grok-provider.md)：xAI 输入、OAuth 字段和 Grok CLI 输出结构。

---

## 输出文件命名

文件名、目录、稳定身份和 JSONL 聚合规则由 [conversion-rules.md 的“文件命名”](conversion-rules.md#文件命名) 统一定义，本 CLI 文档不重复维护第二份规则。

---

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功。 |
| `1` | 未找到可转换账号、所有所选格式均无产物，或批量输入中有部分账号因平台冲突等明确错误被拒绝；有正常产物时仍会写出。 |
| `2` | 参数错误（未知参数、互斥冲突、`--stdout` 遇多文件）。 |
| `3` | IO 错误（路径不存在、目标已存在且未加 `--force`）。 |

---

## 用法示例

```bash
# 默认:识别输入,写入 ./output/
authconv creds.json

# 指定格式与目录
authconv creds.json -f cpa -o out/

# 多个文件/目录一起输入
authconv a.json b.json accounts/ -f cpa -o out/

# 重复 -i/--input
authconv -i a.json --input accounts/ -f sub2api

# 管道:单格式单文件输出到 stdout
authconv creds.json -f sub2api --stdout | jq .

# 输出 Codex CLI auth.json
authconv creds.json -f codex --stdout

# 显式从 stdin 读取
cat creds.json | authconv --stdin -f cpa --stdout

# 目录批量输入,合并为一个 sub2api 文件
authconv accounts/ -f sub2api

# 每账号单独一个 sub2api 文件
authconv accounts/ -f sub2api --mode sub2api=single -o out/

# JSONL 文本：每行一个 CPA JSON
authconv accounts/ -f cpa --jsonl -o out/

# 多格式 JSONL 文本：每个格式目录一个 .jsonl
authconv accounts/ -f cpa,sub2api --jsonl -o out/

# 输出一个 zip
authconv accounts/ -f all --zip -o out/

# 导入 zip
authconv authconv_3-accounts.zip -f cpa -o out/

# 本地打开 Web UI
authconv --serve
authconv --serve --listen 127.0.0.1:8787

# 转换前先核对解析结果,不落盘
authconv accounts/ --inspect

# 预览文件计划,先不写
authconv creds.json -f all -o out/ --dry-run

# 覆盖已有输出
authconv creds.json -f cpa -o out/ --force
```

`--inspect` 输出示例：

```
#  邮箱               account_id  套餐  过期
1  user@example.com   acc_123     plus  2026-10-02
2  other@example.com  acc_456     team  —
```

---

## 安全提示

- **本地转换，零上传**：CLI 不发起网络请求；web 版转换、解析、导出均在浏览器本地完成，不上传凭据。`check:dist` 校验产物不含外部脚本 / CDN / 存储 API。
- **默认输出目录含真实凭证**：默认写入的 `output/` 会包含可解码的 access_token、refresh_token、session_token 等敏感字段。请务必将 `output/` 加入 `.gitignore`，避免误提交。凭证一旦进入版本历史应视为已泄漏，需在源头轮换。
- 除 `--stdout` 的正文外，帮助、版本、摘要、预览、warning 和错误都输出到 stderr，便于管道只读取 JSON/JSONL 正文。
- 读写目录时优先用 `--dry-run` 确认计划，用 `--force` 显式表达覆盖意图。
