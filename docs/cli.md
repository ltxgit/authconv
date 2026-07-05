# authconv CLI

ChatGPT / Codex OAuth 凭证格式转换工具的命令行参考。

`authconv` 把一份或多份凭证输入（ChatGPT `/api/auth/session` 响应、Codex `auth.json`、sub2api 导出、或散装 token JSON）归一化后，渲染成目标工具所需的格式（CPA / sub2api / codex2api / Codex-Manager / Codex auth.json），并写入文件或输出到 stdout。所有运算在本地完成，不发起任何网络请求。

---

## 调用方式

```bash
# 全局链接后
authconv <input...> [options]

# 或直接跑打包产物
node dist/cli.mjs <input...> [options]
```

源码安装命令：

```bash
git clone https://github.com/ltxgit/authconv.git
cd authconv
npm ci
npm run build
npm link
```

`npm link` 会把全局命令 `authconv` 指向本项目的 `dist/cli.mjs`。不想全局链接时，在项目目录内直接运行 `node dist/cli.mjs ...` 即可。更新源码后重新执行 `npm run build`；取消全局命令用 `npm unlink -g authconv`。

命令是**纯扁平**结构：没有子命令，一切通过参数控制。`<input...>` 可以是一个或多个文件/目录；从 stdin 读取时必须显式传 `--stdin`；完全无参数时显示帮助。输入内容支持单个 JSON、JSONL，以及连续拼接的多个完整 JSON 文档。`--serve` 是独立的本地 Web UI 模式，不读取输入、不写输出文件。

---

## 语法

```
authconv [<input...>] [options]
```

- 指定文件：解析文件内容，支持单个 JSON / JSONL / 多 JSON 文档流。
- 指定目录：非递归解析目录一级的 `.json` / `.jsonl` 文件（按文件名排序），账号合并处理。
- 指定多个路径：按命令行顺序读取每个文件或目录，目录内部仍按文件名排序。
- 显式传 `--stdin`：从 stdin 读取同样的 JSON / JSONL / 多 JSON 文档流。
- 完全无参数：显示帮助，不读取 stdin。
- 未指定路径且未传 `--stdin`：报错，不隐式等待 stdin。

---

## 参数

### 输入

| 参数 | 说明 |
|---|---|
| `<path...>` | 输入 JSON 文件或目录（位置参数），可传多个。 |
| `-i, --input <path>` | 同上的显式形式，可重复，也可和位置参数混用。 |
| `--stdin` | 显式从 stdin 读取输入。与 `<path...>` / `-i` 互斥。 |

### 输出格式

| 参数 | 说明 |
|---|---|
| `-f, --format <list>` | 输出格式，逗号分隔或重复传入。可用值：`cpa` `sub2api` `codex2api` `codexmanager` `codex` `all`。 |
| `--mode <fmt>=<m>` | 为**可聚合格式**设置产出方式，`m ∈ merged \| single`。可重复。仅对 `sub2api` / `codex2api` 生效（其余格式恒为每账号一文件）。 |

未指定 `-f` 时默认输出所有格式（`all`）。

### 输出文本

| 参数 | 说明 |
|---|---|
| `--jsonl` | JSONL 文本模式。每个账号一行，按格式聚合为 `.jsonl`。 |

JSONL 会强制可聚合格式按单账号输出，保证每行只包含一个账号：

- CPA / Codex-Manager 多账号本来会拆成多个 JSON 文件，JSONL 会变成每账号一行。
- `sub2api` / `codex2api` 即使默认或显式设置为 `merged`，在 JSONL 下也会按账号拆行。
- `--mode sub2api=merged` / `--mode codex2api=merged` 对 JSONL 不生效；JSONL 优先。

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
| `--dry-run` | 打印将要写入的文件计划（路径 + 账号数），不实际写盘。 |
| `--force` | 允许覆盖已存在的目标文件。默认遇到同名文件报错退出。 |
| `--no-fake-id` | 最终输出不包含 synthetic `id_token`。默认会为 synthetic `id_token` 写入非空占位签名段。 |
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

字段补全、synthetic `id_token`、去重和各格式输出映射见 [conversion-rules.md](conversion-rules.md)。

---

## 输出文件命名

命名策略：保留邮箱域名的点号、下划线和 UUID 的连字符，比全压小写连字符可读得多，并用 `account_id` 前 12 位辅助消歧。

### 脱敏规则

单一规则：把 `[^\w\-.]` 之外的字符替换成 `_`。即保留 **字母 / 数字 / `_` / `-` / `.`**，其余（`@` `+` 空格等）转 `_`。

```
safe("langtron652+1@gmail.com") = "langtron652_1_gmail.com"
```

### 文件名结构

```
{prefix}_{safe(email)}_{acct12}.json
```

- `{prefix}` —— 按输出格式区分，即便文件脱离 `<format>/` 子目录也能自识别：

  | 格式 | 前缀 |
  |---|---|
  | `cpa` | `cpa` |
  | `sub2api` | `sub2api` |
  | `codex2api` | `codex2api` |
  | `codexmanager` | `codex-manager` |
  | `codex` | `codex` |

- `{safe(email)}` —— 账号邮箱经脱敏；缺失时依次回退 `name` → `unknown`。
- `{acct12}` —— `chatgpt_account_id`（回退 `account_id`）的**前 12 位**；为空则省略此段及其前导 `_`。

### 目录与聚合

- **单一输出格式**：文件直接落在输出目录根下，不加子目录。
- **多个输出格式**：每种格式各建一个 `<format>/` 子目录。
- **单账号文件**（single / 不可聚合格式）：如上 `{prefix}_{safe(email)}_{acct12}.json`。
- **聚合文件**（merged，含多账号）：`{prefix}_{账号数}-accounts.json`（单账号时退化为上面的单账号命名）。
- **JSONL 文件**：沿用同一命名策略，扩展名改为 `.jsonl`。多账号单格式 CPA 会输出 `cpa_2-accounts.jsonl`；多格式时会输出到对应格式目录，例如 `cpa/cpa_2-accounts.jsonl`。
- 同一批次内部命名冲突会自动追加 `-2`、`-3` 后缀；如果目标路径在磁盘上已存在，默认报错，需显式加 `--force` 才覆盖。

### 示例

```
# 单账号 CPA
cpa_langtron652_1_gmail.com_eb6642e8-b4a.json

# 单账号 codex-manager
codex-manager_langtron652_1_gmail.com_eb6642e8-b4a.json

# 无 account_id 的单账号 sub2api
sub2api_user_example.com.json

# 聚合的 6 账号 sub2api
sub2api_6-accounts.json
```

---

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功。 |
| `1` | 未找到可转换账号 / 输入无有效凭证。 |
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
warning: creds.json: 已生成合成 id_token
```

---

## 安全提示

- **本地转换，零上传**：CLI 不发起网络请求；web 版转换、解析、导出均在浏览器本地完成，不上传凭据。`check:dist` 校验产物不含外部脚本 / CDN / 存储 API。
- **默认输出目录含真实凭证**：默认写入的 `output/` 会包含可解码的 access_token、refresh_token、session_token 等敏感字段。请务必将 `output/` 加入 `.gitignore`，避免误提交。凭证一旦进入版本历史应视为已泄漏，需在源头轮换。
- 除 `--stdout` 的正文外，帮助、版本、摘要、预览、warning 和错误都输出到 stderr，便于管道只读取 JSON/JSONL 正文。
- 读写目录时优先用 `--dry-run` 确认计划，用 `--force` 显式表达覆盖意图。
