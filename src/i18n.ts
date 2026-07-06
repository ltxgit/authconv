import type { InputFormat, Locale, OutputFormat, OutputMode } from "./types.js";

export const DEFAULT_LOCALE: Locale = "en";

export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh_")) {
    return "zh";
  }
  if (normalized === "en" || normalized === "en-us" || normalized.startsWith("en_")) {
    return "en";
  }
  return undefined;
}

export function detectCliLocale(explicit: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Locale {
  return (
    normalizeLocale(explicit) ??
    normalizeLocale(env.AUTHCONV_LANG) ??
    normalizeLocale(env.LC_ALL) ??
    normalizeLocale(env.LC_MESSAGES) ??
    normalizeLocale(env.LANG) ??
    DEFAULT_LOCALE
  );
}

export function detectWebLocale(search: string): Locale {
  return normalizeLocale(new URLSearchParams(search).get("lang")) ?? DEFAULT_LOCALE;
}

export function localeName(locale: Locale): string {
  return locale === "zh" ? "中文" : "English";
}

export const INPUT_FORMAT_LABELS: Record<Locale, Record<InputFormat, string>> = {
  zh: {
    session: "ChatGPT Session",
    sub2api: "sub2api",
    cpa: "CPA",
    codexmanager: "Codex Manager",
    codex2api: "Codex2Api",
    codex: "Codex Auth",
    unknown: "未知格式",
  },
  en: {
    session: "ChatGPT Session",
    sub2api: "sub2api",
    cpa: "CPA",
    codexmanager: "Codex Manager",
    codex2api: "Codex2Api",
    codex: "Codex Auth",
    unknown: "Unknown format",
  },
};

export const INPUT_FORMAT_BADGE_LABELS: Record<InputFormat, string> = {
  session: "Session",
  sub2api: "sub2api",
  cpa: "CPA",
  codexmanager: "Codex Manager",
  codex2api: "Codex2Api",
  codex: "Codex Auth",
  unknown: "Unknown",
};

export const FORMAT_LABELS: Record<OutputFormat, string> = {
  cpa: "CPA",
  sub2api: "sub2api",
  codex2api: "codex2api",
  codexmanager: "Codex Manager",
  codex: "Codex Auth",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

type CliMessages = {
  help: (version: string) => string;
  inputPathSource: string;
  errors: {
    noAccounts: string;
    cwdMissing: string;
    unknownArg: (arg: string) => string;
    missingInput: string;
    invalidModeSyntax: (value: string) => string;
    unknownOutputFormat: (format: string) => string;
    unsupportedModeFormat: (format: string) => string;
    unknownOutputMode: (mode: string) => string;
    stdinConflict: (source: string) => string;
    stdinPathConflict: string;
    missingFlagValue: (flag: string) => string;
    noInputFiles: (inputPath: string) => string;
    notFileOrDirectory: (inputPath: string) => string;
    unsupportedInputFile: (inputPath: string) => string;
    stdoutSingleFile: string;
    zipStdoutConflict: string;
    inspectTargetConflict: string;
    inspectDryRunConflict: string;
    dryRunStdoutConflict: string;
    invalidLang: (value: string) => string;
    invalidListen: (value: string) => string;
    invalidPort: (value: string) => string;
    serveConflict: string;
    serveOptionWithoutServe: string;
    notFound: (target: string) => string;
    alreadyExists: (target: string) => string;
  };
  serve: {
    started: (url: string) => string;
  };
  summary: {
    human: (accountCount: number, fileCount: number, formatCount: number, formats: string, outputRoot?: string) => string;
    humanFile: (accountCount: number, formatCount: number, formats: string, targetPath: string) => string;
    inspectColumns: string[];
    unknownAccount: string;
    missingValue: string;
    dryRun: (accountCount: number, fileCount: number, outputRoot: string) => string;
    fileLine: (path: string, accountCount: number) => string;
    warning: string;
    groupedWarnings: (message: string, sources: string[]) => string;
  };
};

type NormalizeMessages = {
  invalidInputFormat: (sourceName: string, inputFormat: string) => string;
  noTokens: (sourceName: string) => string;
  invalidExpiry: (sourceName: string, value: string) => string;
  syntheticIdToken: (sourceName: string) => string;
  missingIdToken: (sourceName: string) => string;
  missingRefreshToken: (sourceName: string) => string;
  missingAccessToken: (sourceName: string) => string;
  claimOverride: (sourceName: string, fields: string[]) => string;
  claimSanity: (sourceName: string, fields: string[]) => string;
};

type WebMessages = {
  pageTitle: string;
  appTitle: string;
  notice: string;
  dragTitle: string;
  dragSub: string;
  themeLabel: string;
  themeAria: string;
  themeSystem: string;
  themeLight: string;
  themeDark: string;
  languageLabel: string;
  languageAria: string;
  inputTitle: string;
  sessionButton: string;
  addDraftButton: string;
  clearButton: string;
  inputAria: string;
  inputPlaceholder: string;
  inputFormatAria: string;
  dropZoneAria: string;
  dropTitle: string;
  dropSub: string;
  chooseFile: string;
  chooseFolder: string;
  outputTitle: string;
  downloadDefault: string;
  outputSettingsAria: string;
  exportFormat: string;
  selectAllFormatsAria: string;
  outputOptions: string;
  jsonlFormat: string;
  fakeId: string;
  accountTitle: string;
  clearAccounts: string;
  accountColumns: [string, string, string, string];
  accountListAria: string;
  previewAria: string;
  previewTabsAria: string;
  copyPreview: string;
  copied: string;
  copyToast: string;
  copyFailed: string;
  inputFormatAutoMixed: string;
  inputFormatAuto: (label: string) => string;
  inputInvalidFormat: (label: string) => string;
  jsonParseFailed: (error: string) => string;
  noAccounts: string;
  sourceName: (index: number) => string;
  sourceImported: (processed: number, added: number, merged: number) => string;
  fileImported: (processed: number, added: number, merged: number) => string;
  chooseJsonFile: string;
  fileNoAccounts: (name: string) => string;
  fileInvalidInput: (name: string, error: string) => string;
  fileJsonFailed: (name: string, error: string) => string;
  fileReadFailed: (error: string) => string;
  accountCount: (count: number) => string;
  formatCount: (count: number) => string;
  exportAccounts: (count: number) => string;
  exportPreparing: string;
  exportAria: (count: number, jsonl: boolean, zip: boolean) => string;
  previewNoFormat: string;
  previewNoInput: string;
  accountLabelFallback: string;
  accountLabelPrefixDraft: (label: string) => string;
  accountCellAccount: string;
  planType: string;
  expiresAt: string;
  unknown: string;
  action: string;
  remove: string;
  removeAccount: (label: string) => string;
  jsonlTooltip: string;
  fakeIdTooltip: string;
  codexManagerTooltip: string;
  codexTooltip: string;
  modeSingle: string;
  modeMerged: string;
  modeSingleTip: string;
  modeMergedTip: string;
  nextModeLabel: (mode: OutputMode) => string;
  modeAria: (format: string, current: string, tip: string, next: string) => string;
  exportZipToast: (name: string) => string;
  exportFileToast: string;
};

type Messages = {
  cli: CliMessages;
  normalize: NormalizeMessages;
  web: WebMessages;
};

export const MESSAGES: Record<Locale, Messages> = {
  zh: {
    cli: {
      help: (version) => `authconv ${version}

用法:
  authconv input.json
  authconv input-a.json input-b.json input-dir -f cpa
  authconv input-dir -f sub2api
  authconv -i input-a.json -i input-b.json
  authconv --stdin -f cpa --stdout
  authconv input.json -f cpa,sub2api
  authconv input.json --format cpa --format codexmanager
  authconv input.json -f codex --stdout
  authconv input.json -f sub2api --stdout
  authconv input.json -f cpa --jsonl
  authconv --serve

参数:
  <path...>              输入 JSON/JSONL/ZIP 文件或目录路径，可传多个
  -i, --input <path>     指定 JSON/JSONL/ZIP 文件或目录（可重复）
  --stdin                从标准输入读取（与 -i 互斥）
  -f, --format <list>    输出格式，支持逗号分隔或重复传入；可用 cpa/sub2api/codex2api/codexmanager/codex/all
  --mode <fmt>=<m>       sub2api/codex2api 输出方式：merged 或 single
  -o, --out-dir <path>   输出目录，默认 output
  --jsonl                输出 JSONL 格式（每账号一行）
  --zip                  写入一个 ZIP 文件，压缩包内保留当前输出目录结构
  --stdout               单格式单文件输出到 stdout
  --no-fake-id           输出不包含合成 id_token（默认会输出）
  --lang <zh|en>         人类可读输出语言，未检测到时默认英文
  --inspect              只打印账号摘要，不产出文件
  --dry-run              只打印写入计划，不实际写盘
  --force                允许覆盖已存在的目标文件
  --serve                启动本地 Web UI，默认监听 127.0.0.1:8787
  --listen <host:port>   Web UI 监听地址，仅与 --serve 一起使用
  --help                 显示帮助
  --version              显示版本
`,
      inputPathSource: "输入路径",
      errors: {
        noAccounts: "未找到可转换账号",
        cwdMissing: "当前目录不存在",
        unknownArg: (arg) => `未知参数: ${arg}`,
        missingInput: "未指定输入（需要 <path>、-i 或 --stdin）",
        invalidModeSyntax: (value) => `--mode 格式错误: ${value}（应为 format=merged|single）`,
        unknownOutputFormat: (format) => `未知输出格式: ${format}`,
        unsupportedModeFormat: (format) => `--mode 仅支持 sub2api 或 codex2api: ${format}`,
        unknownOutputMode: (mode) => `--mode 包含未知输出方式: ${mode}`,
        stdinConflict: (source) => `${source} 与 --stdin 冲突，只能指定一个输入来源`,
        stdinPathConflict: "--stdin 与已有输入路径冲突，只能指定一个输入来源",
        missingFlagValue: (flag) => `${flag} 缺少参数值`,
        noInputFiles: (inputPath) => `${inputPath}: 未找到输入文件`,
        notFileOrDirectory: (inputPath) => `${inputPath}: 不是文件或目录`,
        unsupportedInputFile: (inputPath) => `${inputPath}: 不支持的输入文件类型（仅支持 .json、.jsonl、.zip）`,
        stdoutSingleFile: "--stdout 只支持单格式输出，且该格式只能生成一个文件",
        zipStdoutConflict: "--zip 与 --stdout 互斥",
        inspectTargetConflict: "--inspect 与 -o/--out-dir/--stdout/--zip 互斥",
        inspectDryRunConflict: "--inspect 与 --dry-run 互斥",
        dryRunStdoutConflict: "--dry-run 与 --stdout 互斥",
        invalidLang: (value) => `未知语言: ${value}（可用 zh/en）`,
        invalidListen: (value) => `监听地址无效: ${value}（应为 host:port）`,
        invalidPort: (value) => `端口无效: ${value}`,
        serveConflict: "--serve 不能和输入、转换或输出参数一起使用",
        serveOptionWithoutServe: "--listen 只能和 --serve 一起使用",
        notFound: (target) => `${target}: 不存在`,
        alreadyExists: (target) => `${target}: 已存在，使用 --force 覆盖`,
      },
      serve: {
        started: (url) => `Web UI 已启动: ${url}\n按 Ctrl+C 退出。\n`,
      },
      summary: {
        human: (accountCount, fileCount, _formatCount, formats, outputRoot) => `识别 ${accountCount} 个账号，转为 ${formats} 格式，写入 ${fileCount} 个文件${outputRoot ? `到 ${outputRoot}` : ""}`,
        humanFile: (accountCount, _formatCount, formats, targetPath) => `识别 ${accountCount} 个账号，转为 ${formats} 格式，写入 ${targetPath}`,
        inspectColumns: ["#", "邮箱", "account_id", "套餐", "过期"],
        unknownAccount: "unknown",
        missingValue: "—",
        dryRun: (accountCount, fileCount, outputRoot) => `识别 ${accountCount} 个账号，将写入 ${fileCount} 个文件到 ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${accountCount} 个账号)`,
        warning: "warning",
        groupedWarnings: (message, sources) => `${message} (${sources.length} 条 warning)`,
      },
    },
    normalize: {
      invalidInputFormat: (sourceName, inputFormat) => `${sourceName}: 输入不符合 ${inputFormat} 输入格式`,
      noTokens: (sourceName) => `${sourceName}: 未找到可识别 token 字段`,
      invalidExpiry: (sourceName, value) => `${sourceName}: 过期时间格式错误 ("${value}")`,
      syntheticIdToken: (sourceName) => `${sourceName}: 已生成合成 id_token`,
      missingIdToken: (sourceName) => `${sourceName}: 缺少 id_token`,
      missingRefreshToken: (sourceName) => `${sourceName}: 缺少 refresh_token`,
      missingAccessToken: (sourceName) => `${sourceName}: 缺少 access_token`,
      claimOverride: (sourceName, fields) => `${sourceName}: access_token claim 不一致，覆盖字段: ${fields.join(",")}`,
      claimSanity: (sourceName, fields) => `${sourceName}: JWT claim 校验异常: ${fields.join(",")}`,
    },
    web: {
      pageTitle: "GPT Auth 转换 | 纯本地安全凭据多格式处理工具",
      appTitle: "GPT Auth 转换",
      notice: "纯本地安全转换，所有运算在当前浏览器中完成。",
      dragTitle: "释放以导入 JSON / JSONL / ZIP 凭据",
      dragSub: "松开添加到列表",
      themeLabel: "主题",
      themeAria: "切换和选择主题",
      themeSystem: "自动",
      themeLight: "浅色",
      themeDark: "深色",
      languageLabel: "语言",
      languageAria: "切换语言",
      inputTitle: "数据输入",
      sessionButton: "获取 Session",
      addDraftButton: "加入列表",
      clearButton: "清空",
      inputAria: "JSON 凭据输入",
      inputPlaceholder: `请在此处直接粘贴 ChatGPT /api/auth/session JSON 响应、Codex auth.json、JSONL 文本，或者从下方拖入多账号 JSON 导出配置...

例如：
{
  "access_token": "sample-access-token",
  "refresh_token": "sample-refresh-token",
  "session_token": "sample-session-token",
  "email": "user@example.com",
  "name": "Example User",
  "chatgpt_account_id": "acct_example",
  "chatgpt_user_id": "user_example",
  "plan_type": "plus",
  "last_refresh": "2026-07-03T00:00:00.000Z",
  "expires_at": "2026-07-03T01:00:00.000Z"
}`,
      inputFormatAria: "输入格式",
      dropZoneAria: "选择或拖放 JSON、JSONL、ZIP 凭据文件或文件夹",
      dropTitle: "选择或拖放 .json / .jsonl / .zip 凭据文件",
      dropSub: "拖入文件或文件夹",
      chooseFile: "选择文件",
      chooseFolder: "选择文件夹",
      outputTitle: "数据输出",
      downloadDefault: "导出配置",
      outputSettingsAria: "输出设置",
      exportFormat: "导出格式",
      selectAllFormatsAria: "全选导出格式",
      outputOptions: "输出选项",
      jsonlFormat: "JSONL 格式",
      fakeId: "合成 id_token",
      accountTitle: "已加载账号",
      clearAccounts: "清空列表",
      accountColumns: ["账号标识 (Email / ID)", "套餐状态", "过期时间", "操作"],
      accountListAria: "账号列表",
      previewAria: "输出预览",
      previewTabsAria: "预览格式选择",
      copyPreview: "复制当前预览",
      copied: "✓ 已复制到剪贴板",
      copyToast: "已复制到剪贴板",
      copyFailed: "复制失败，请手动选择预览内容复制",
      inputFormatAutoMixed: "自动识别：逐个检查",
      inputFormatAuto: (label) => `自动识别：${label}`,
      inputInvalidFormat: (label) => `输入不符合 ${label} 格式。`,
      jsonParseFailed: (error) => `JSON 解析失败：${error}`,
      noAccounts: "未识别到可转换账号。",
      sourceName: (index) => `输入 ${index}`,
      sourceImported: (processed, added, merged) => `已读取 ${processed} 个账号，新增 ${added} 个，合并重复 ${merged} 个`,
      fileImported: (processed, added, merged) => `已读取 ${processed} 个账号，新增 ${added} 个，合并重复 ${merged} 个`,
      chooseJsonFile: "请选择 .json、.jsonl 或 .zip 文件。",
      fileNoAccounts: (name) => `${name}: 未识别到可转换账号。`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON 解析失败（${name}）：${error}`,
      fileReadFailed: (error) => `文件读取失败：${error}`,
      accountCount: (count) => `${count} 个账号`,
      formatCount: (count) => `${count} 种格式`,
      exportAccounts: (count) => `导出 ${count} 个账号`,
      exportPreparing: "正在打包...",
      exportAria: (count, jsonl, zip) => [
        `导出 ${count} 个账号`,
        jsonl ? "JSONL：每行一个账号。" : "",
        zip ? "多格式或多文件会自动打包为 ZIP。" : "",
      ].filter(Boolean).join(" "),
      previewNoFormat: "选择导出格式后显示预览。",
      previewNoInput: "输入 JSON 后显示当前格式预览。",
      accountLabelFallback: "未识别账号",
      accountLabelPrefixDraft: (label) => `草稿 ${label}`,
      accountCellAccount: "账号",
      planType: "套餐类型",
      expiresAt: "过期时间",
      unknown: "未识别",
      action: "操作",
      remove: "删除",
      removeAccount: (label) => `删除 ${label}`,
      jsonlTooltip: "JSONL：行式 JSON 格式，每行一个账号（适合单行凭据导入等场景）。",
      fakeIdTooltip: "合成 id_token：针对缺少 id_token 的账号自动合成模拟凭据，以兼容 Codex Auth 等下游工具。",
      codexManagerTooltip: "Codex-Manager 格式。",
      codexTooltip: "Codex auth.json 格式。",
      modeSingle: "单个",
      modeMerged: "聚合",
      modeSingleTip: "单个：每账号 1 个文件。",
      modeMergedTip: "聚合：1 个汇总文件。",
      nextModeLabel: (mode) => (mode === "single" ? "聚合" : "单个"),
      modeAria: (format, current, tip, next) => `切换 ${format} 导出方式，当前${current}。${tip} 点击切换为${next}`,
      exportZipToast: (name) => `已开始导出 ${name}`,
      exportFileToast: "已开始导出文件",
    },
  },
  en: {
    cli: {
      help: (version) => `authconv ${version}

Usage:
  authconv input.json
  authconv input-a.json input-b.json input-dir -f cpa
  authconv input-dir -f sub2api
  authconv -i input-a.json -i input-b.json
  authconv --stdin -f cpa --stdout
  authconv input.json -f cpa,sub2api
  authconv input.json --format cpa --format codexmanager
  authconv input.json -f codex --stdout
  authconv input.json -f sub2api --stdout
  authconv input.json -f cpa --jsonl
  authconv --serve

Options:
  <path...>              Input JSON/JSONL/ZIP file or directory path; may repeat
  -i, --input <path>     Input JSON/JSONL/ZIP file or directory path; may repeat
  --stdin                Read from standard input; conflicts with paths
  -f, --format <list>    Output formats, comma-separated or repeated; cpa/sub2api/codex2api/codexmanager/codex/all
  --mode <fmt>=<m>       sub2api/codex2api output mode: merged or single
  -o, --out-dir <path>   Output directory, default output
  --jsonl                Output JSONL text, one JSON document per line
  --zip                  Write one ZIP file and keep the current output tree inside it
  --stdout               Write a single output file to stdout
  --no-fake-id           Omit synthetic id_token from output (included by default)
  --lang <zh|en>         Human-readable output language, default en when undetected
  --inspect              Print account summary only
  --dry-run              Print write plan without writing files
  --force                Overwrite existing output files
  --serve                Start local Web UI, default listen address 127.0.0.1:8787
  --listen <host:port>   Web UI listen address; only valid with --serve
  --help                 Show help
  --version              Show version
`,
      inputPathSource: "input path",
      errors: {
        noAccounts: "No convertible accounts found",
        cwdMissing: "Current directory no longer exists",
        unknownArg: (arg) => `Unknown argument: ${arg}`,
        missingInput: "No input specified; pass <path>, -i, or --stdin",
        invalidModeSyntax: (value) => `Invalid --mode: ${value} (expected format=merged|single)`,
        unknownOutputFormat: (format) => `Unknown output format: ${format}`,
        unsupportedModeFormat: (format) => `--mode only supports sub2api or codex2api: ${format}`,
        unknownOutputMode: (mode) => `Unknown output mode in --mode: ${mode}`,
        stdinConflict: (source) => `${source} conflicts with --stdin; choose one input source`,
        stdinPathConflict: "--stdin conflicts with input paths; choose one input source",
        missingFlagValue: (flag) => `${flag} requires a value`,
        noInputFiles: (inputPath) => `${inputPath}: no input files found`,
        notFileOrDirectory: (inputPath) => `${inputPath}: not a file or directory`,
        unsupportedInputFile: (inputPath) => `${inputPath}: unsupported input file type (expected .json, .jsonl, or .zip)`,
        stdoutSingleFile: "--stdout only supports one format that produces one file",
        zipStdoutConflict: "--zip conflicts with --stdout",
        inspectTargetConflict: "--inspect conflicts with -o/--out-dir/--stdout/--zip",
        inspectDryRunConflict: "--inspect conflicts with --dry-run",
        dryRunStdoutConflict: "--dry-run conflicts with --stdout",
        invalidLang: (value) => `Unknown language: ${value} (use zh or en)`,
        invalidListen: (value) => `Invalid listen address: ${value} (expected host:port)`,
        invalidPort: (value) => `Invalid port: ${value}`,
        serveConflict: "--serve cannot be combined with input, conversion, or output options",
        serveOptionWithoutServe: "--listen can only be used with --serve",
        notFound: (target) => `${target}: not found`,
        alreadyExists: (target) => `${target}: already exists; use --force to overwrite`,
      },
      serve: {
        started: (url) => `Web UI started: ${url}\nPress Ctrl+C to stop.\n`,
      },
      summary: {
        human: (accountCount, fileCount, formatCount, formats, outputRoot) => `Found ${plural(accountCount, "account")}, converted to ${formats} ${formatCount === 1 ? "format" : "formats"}, wrote ${plural(fileCount, "file")}${outputRoot ? ` to ${outputRoot}` : ""}`,
        humanFile: (accountCount, formatCount, formats, targetPath) => `Found ${plural(accountCount, "account")}, converted to ${formats} ${formatCount === 1 ? "format" : "formats"}, wrote ${targetPath}`,
        inspectColumns: ["#", "email", "account_id", "plan", "expires"],
        unknownAccount: "unknown",
        missingValue: "-",
        dryRun: (accountCount, fileCount, outputRoot) => `Found ${plural(accountCount, "account")}, would write ${plural(fileCount, "file")} to ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${plural(accountCount, "account")})`,
        warning: "warning",
        groupedWarnings: (message, sources) => `${message} (${plural(sources.length, "warning")})`,
      },
    },
    normalize: {
      invalidInputFormat: (sourceName, inputFormat) => `${sourceName}: input is not ${inputFormat}`,
      noTokens: (sourceName) => `${sourceName}: no recognizable token fields found`,
      invalidExpiry: (sourceName, value) => `${sourceName}: invalid expiry time ("${value}")`,
      syntheticIdToken: (sourceName) => `${sourceName}: generated synthetic id_token`,
      missingIdToken: (sourceName) => `${sourceName}: missing id_token`,
      missingRefreshToken: (sourceName) => `${sourceName}: missing refresh_token`,
      missingAccessToken: (sourceName) => `${sourceName}: missing access_token`,
      claimOverride: (sourceName, fields) => `${sourceName}: access_token claim mismatch, overwritten fields: ${fields.join(",")}`,
      claimSanity: (sourceName, fields) => `${sourceName}: invalid JWT claims: ${fields.join(",")}`,
    },
    web: {
      pageTitle: "GPT Auth Converter | Local credential format converter",
      appTitle: "GPT Auth Converter",
      notice: "Local-only conversion. Everything runs in this browser.",
      dragTitle: "Drop to import JSON / JSONL / ZIP credentials",
      dragSub: "Release to add to the list",
      themeLabel: "Theme",
      themeAria: "Switch and choose theme",
      themeSystem: "Auto",
      themeLight: "Light",
      themeDark: "Dark",
      languageLabel: "Language",
      languageAria: "Switch language",
      inputTitle: "Input",
      sessionButton: "Get Session",
      addDraftButton: "Add to List",
      clearButton: "Clear",
      inputAria: "JSON credential input",
      inputPlaceholder: `Paste a ChatGPT /api/auth/session JSON response, Codex auth.json, JSONL text, or drop multi-account JSON exports below...

Example:
{
  "access_token": "sample-access-token",
  "refresh_token": "sample-refresh-token",
  "session_token": "sample-session-token",
  "email": "user@example.com",
  "name": "Example User",
  "chatgpt_account_id": "acct_example",
  "chatgpt_user_id": "user_example",
  "plan_type": "plus",
  "last_refresh": "2026-07-03T00:00:00.000Z",
  "expires_at": "2026-07-03T01:00:00.000Z"
}`,
      inputFormatAria: "Input format",
      dropZoneAria: "Choose or drop JSON, JSONL, or ZIP credential files or folders",
      dropTitle: "Choose or drop .json / .jsonl / .zip credential files",
      dropSub: "Drop files or folders",
      chooseFile: "Choose File",
      chooseFolder: "Choose Folder",
      outputTitle: "Output",
      downloadDefault: "Export",
      outputSettingsAria: "Output settings",
      exportFormat: "Export Formats",
      selectAllFormatsAria: "Select all output formats",
      outputOptions: "Options",
      jsonlFormat: "JSONL Format",
      fakeId: "Synthetic id_token",
      accountTitle: "Loaded Accounts",
      clearAccounts: "Clear List",
      accountColumns: ["Account (Email / ID)", "Plan", "Expires At", "Action"],
      accountListAria: "Account list",
      previewAria: "Output preview",
      previewTabsAria: "Preview format selection",
      copyPreview: "Copy Preview",
      copied: "✓ Copied",
      copyToast: "Copied to clipboard",
      copyFailed: "Copy failed. Select and copy the preview manually.",
      inputFormatAutoMixed: "Auto detect: inspect each document",
      inputFormatAuto: (label) => `Auto detect: ${label}`,
      inputInvalidFormat: (label) => `Input is not ${label}.`,
      jsonParseFailed: (error) => `JSON parse failed: ${error}`,
      noAccounts: "No convertible accounts found.",
      sourceName: (index) => `Input ${index}`,
      sourceImported: (processed, added, merged) => `Read ${processed} account(s), added ${added}, merged ${merged} duplicate(s)`,
      fileImported: (processed, added, merged) => `Read ${processed} account(s), added ${added}, merged ${merged} duplicate(s)`,
      chooseJsonFile: "Choose .json, .jsonl, or .zip files.",
      fileNoAccounts: (name) => `${name}: no convertible accounts found.`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON parse failed (${name}): ${error}`,
      fileReadFailed: (error) => `File read failed: ${error}`,
      accountCount: (count) => `${count} account(s)`,
      formatCount: (count) => `${count} formats`,
      exportAccounts: (count) => `Export ${count} account(s)`,
      exportPreparing: "Packaging...",
      exportAria: (count, jsonl, zip) => [
        `Export ${count} account(s)`,
        jsonl ? "JSONL: one account per line." : "",
        zip ? "Multiple formats or files will be packed as ZIP." : "",
      ].filter(Boolean).join(" "),
      previewNoFormat: "Select an output format to preview.",
      previewNoInput: "Paste JSON to preview the selected format.",
      accountLabelFallback: "Unknown account",
      accountLabelPrefixDraft: (label) => `Draft ${label}`,
      accountCellAccount: "Account",
      planType: "Plan",
      expiresAt: "Expires",
      unknown: "Unknown",
      action: "Action",
      remove: "Remove",
      removeAccount: (label) => `Remove ${label}`,
      jsonlTooltip: "JSONL: Line-by-line JSON format, one account per line (suitable for single-line credential imports).",
      fakeIdTooltip: "Synthetic id_token: Automatically generate a simulated token when missing, for compatibility with downstream tools like Codex Auth.",
      codexManagerTooltip: "Codex-Manager format.",
      codexTooltip: "Codex auth.json format.",
      modeSingle: "Single",
      modeMerged: "Merged",
      modeSingleTip: "Single: one file per account.",
      modeMergedTip: "Merged: one combined file.",
      nextModeLabel: (mode) => (mode === "single" ? "Merged" : "Single"),
      modeAria: (format, current, tip, next) => `Switch ${format} output mode. Current: ${current}. ${tip} Click to switch to ${next}.`,
      exportZipToast: (name) => `Started exporting ${name}`,
      exportFileToast: "Started exporting file",
    },
  },
};

export function messagesFor(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function inputFormatLabel(inputFormat: InputFormat, locale: Locale): string {
  return INPUT_FORMAT_LABELS[locale][inputFormat];
}
