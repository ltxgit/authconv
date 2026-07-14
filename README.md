# authconv

OpenAI / Grok OAuth 凭证格式转换工具。

把 ChatGPT `/api/auth/session`、Codex `auth.json`、xAI OIDC、Grok CLI `auth.json`、CPA、sub2api 或散装 token JSON 归一化后，渲染成目标工具所需格式。

转换、解析、导出均在本地完成，不上传凭据；Web 版的“获取 Session”按钮只会按用户点击打开 ChatGPT 官方 session 页面。


- ✅ **OpenAI / Grok** — 自动识别平台，支持混合账号批量转换。
- ✅ **多格式导出** — 支持 CPA、sub2api、codex2api、Codex-Manager、Codex CLI auth.json 和 Grok CLI auth.json。
- ✅ **纯本地转换，零上传** — CLI 不发起网络请求；Web 版转换、解析、导出完全本地运行。
- ✅ **Web 版无需安装** — 直接访问 [https://ltxgit.github.io/authconv/](https://ltxgit.github.io/authconv/) 或者点击项目内 `dist/index.html` 本地打开。

---

## Web 版

三种打开方式，功能完全一致：

1. **在线访问** — [https://ltxgit.github.io/authconv/](https://ltxgit.github.io/authconv/)
2. **本地打开** — 直接双击项目内的 `dist/index.html`
3. **本地起服务** — 运行 `authconv --serve`（或 `node dist/cli.mjs --serve`），默认 `http://127.0.0.1:8787`，只绑定本地回环；用 `--listen host:port` 换地址

功能：

- 纯浏览器端运行，零上传
- 拖拽 JSON / JSONL / ZIP 文件或文件夹，或粘贴 JSON / JSONL 文本；支持的浏览器也可直接选择文件夹
- 支持多格式导出，sub2api / codex2api 可选聚合或单账号模式
- JSONL 单行输出
- 账号列表预览、输出 JSON 中 JWT 密文的悬停解码预览、复制、JSON / ZIP 下载
- 输入格式可自动识别，也可手动指定
- 页面支持中文 / English 切换，选择会写入 URL 方便刷新保留
- 支持跟随系统的明暗主题

---

## CLI 版

### 安装

需要 Node.js 20.19.0 或更新版本。

```bash
git clone https://github.com/ltxgit/authconv.git
cd authconv
npm ci
npm run build
npm link
```

`npm link` 会按 `package.json` 的 `bin` 配置把全局命令 `authconv` 链接到本项目的 `dist/cli.mjs`。之后可以在任意目录里运行：

```bash
authconv --help
authconv creds.json -f cpa
```

不想全局安装时，可以在项目目录内直接运行打包产物：

```bash
node dist/cli.mjs --help
node dist/cli.mjs creds.json -f all -o out/
```

更新源码后重新执行 `npm run build` 即可；`npm link` 通常只需要做一次。取消全局命令：

```bash
npm unlink -g authconv
```

输入路径支持 JSON / JSONL / ZIP 文件和目录，可一次传多个。Shell 展开的 `*.json` 这类通配符会作为多路径输入传给 `authconv`，所以可以直接批量转换。stdin 只支持 JSON / JSONL / 连续拼接的多个完整 JSON 文档；ZIP 只作为文件输入。
完全无参数时显示帮助；从 stdin 读取时必须显式传 `--stdin`。

### 使用

支持输出格式：

- `cpa` — CLIProxyAPI
- `sub2api` — sub2api（默认聚合）
- `codex2api` — codex2api（默认聚合）
- `codexmanager` — Codex-Manager
- `codex` — Codex CLI auth.json
- `grok` — Grok CLI auth.json

常用命令：

```bash
# 默认转换，输出到 ./output
authconv creds.json

# 转成 CPA 格式
authconv creds.json -f cpa -o out/

# 转成 Codex CLI auth.json 格式
authconv creds.json -f codex -o out/

# 一次输出所有格式
authconv creds.json -f all -o out/

# 输出多个指定格式（逗号分隔）
authconv creds.json -f cpa,sub2api -o out/

# 批量转换目录里的 json/jsonl
authconv accounts/ -f all -o out/

# 使用 shell 通配符批量输入
authconv *.json -f cpa

# 只转换文件名包含指定 workspace 标识的 JSON
authconv *workspace-id*.json -f cpa

# 文件、目录、通配符可以混用
authconv current.json archive/ exports/*.json -f all

# 直接导入 ZIP，适合回导本工具导出的多格式压缩包
authconv authconv_3-accounts.zip -f cpa

# 输出一个 zip
authconv accounts/ -f all --zip -o out/

# 输出到 stdout，方便接 jq
authconv creds.json -f sub2api --stdout | jq .

# JSONL 单行模式
authconv accounts/ -f cpa --jsonl -o out/

# 只看解析结果，不写文件
authconv creds.json --inspect

# 预览会写哪些文件
authconv creds.json -f all --dry-run

# 显式从 stdin 读取
cat creds.json | authconv --stdin -f cpa --stdout

# 多个文件/目录一起输入
authconv a.json b.json accounts/ -f cpa
```

### 控制聚合格式的输出方式

可聚合格式（`sub2api`/`codex2api`）默认合并为一个文件：

```bash
# 每账号单独一个文件
authconv accounts/ -f sub2api --mode sub2api=single

# Grok CLI 多账号合并（默认）或拆分
authconv grok-accounts/ -f grok
authconv grok-accounts/ -f grok --mode grok=single

# 合并为一个文件（默认）
authconv accounts/ -f sub2api

# 把多个单账号文件聚合成一个
authconv single-accounts/ -f sub2api -o out/

# 把 sub2api 多账号聚合文件切分成单账号
authconv merged.json -f sub2api --mode sub2api=single -o out/
```

### JSONL 文本模式

```bash
# 输出 JSONL 格式（每账号一行）
authconv accounts/ -f cpa --jsonl
```

JSONL 模式将每个输出 JSON 压缩为单行，并强制 `sub2api` / `codex2api` 按单账号输出。

### 其他选项

```bash
# 预览将写入的文件，不实际写盘
authconv creds.json --dry-run

# 允许覆盖已存在的文件
authconv creds.json -f cpa -o out/ --force

# 指定输出语言（支持 zh/en，未检测到语言时默认英文）
authconv creds.json --lang en --inspect
```

完整 CLI 参考见 [docs/cli.md](docs/cli.md)。

---

## 规则文档

- [通用转换规则](docs/conversion-rules.md)
- [OpenAI / ChatGPT 凭证规则](docs/openai-provider.md)
- [Grok / xAI 凭证规则](docs/grok-provider.md)

---

## 开发

```bash
# 运行测试
npm test

# 类型检查
npm run typecheck

# 构建并验证产物
npm run build
npm run check:dist
```

---

## 致谢

感谢 [Linux.do](https://linux.do/) 社区的讨论与反馈。

---

## License

MIT
