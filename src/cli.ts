import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutputPlan,
  dedupeAccounts,
  detectCliLocale,
  detectInputFormat,
  effectiveOutputModes,
  FORMAT_LABELS,
  normalizeInput,
  parseInputPayload,
  parseFormatList,
  serializeOutputFiles,
  messagesFor,
  normalizeLocale,
  zipOutputFiles,
} from "./index.js";
import { zipDownloadName } from "./download-names.js";
import { isOutputFormat } from "./formats.js";
import type {
  InputFormat,
  Locale,
  NormalizeOptions,
  NormalizeResult,
  OutputFormat,
  OutputMode,
  OutputModes,
  OutputTextMode,
  SerializedOutputFile,
} from "./types.js";

const VERSION = "0.1.0";

export type CliIo = {
  stdin?: string;
  stdout?: string;
  stderr?: string;
  cwd?: string;
  onServerStarted?: (server: WebUiServer) => void;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type WebUiServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

type ParsedArgs = {
  inputPaths: string[];
  stdin: boolean;
  formatValues: string[];
  outDir: string;
  outDirSpecified: boolean;
  outputModes: OutputModes;
  textMode: OutputTextMode;
  stdout: boolean;
  zip: boolean;
  allowSyntheticIdToken: boolean;
  locale: Locale;
  inspect: boolean;
  dryRun: boolean;
  force: boolean;
  serve: boolean;
  serveHost: string;
  servePort: number;
  serveListenSpecified: boolean;
  help: boolean;
  version: boolean;
};

type LoadedInput = {
  input: unknown;
  sourceName: string;
  sourcePath: string;
  inputFormat: InputFormat;
};

class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function runCli(args: string[], io: CliIo = {}): Promise<CliResult> {
  const locale = detectCliLocale(scanLocaleArg(args));
  const messages = messagesFor(locale).cli;
  try {
    const parsed = parseArgs(args, locale);
    if (parsed.help) {
      return info(helpText(locale));
    }
    if (parsed.version) {
      return info(`${VERSION}\n`);
    }

    // 不带任何参数时显示帮助
    if (parsed.inputPaths.length === 0 && !parsed.stdin && args.length === 0) {
      return info(helpText(locale));
    }

    validateParsedArgs(parsed);

    if (parsed.serve) {
      const server = await startWebUiServer({
        host: parsed.serveHost,
        port: parsed.servePort,
      });
      io.onServerStarted?.(server);
      return info(messages.serve.started(server.url));
    }

    const cwd = io.cwd ?? currentWorkingDirectory(parsed.locale);
    const inputPaths = parsed.inputPaths.map((inputPath) => path.resolve(cwd, inputPath));
    const loadedInputs = await readInputs(
      inputPaths,
      parsed.stdin,
      parsed.locale,
      io,
    );
    const normalized = normalizeLoadedInputs(loadedInputs, {
      locale: parsed.locale,
    });

    if (normalized.accounts.length === 0) {
      return fail(1, [messages.errors.noAccounts, ...normalized.warnings]);
    }
    const visibleWarnings = outputWarnings(normalized, parsed.locale, parsed.allowSyntheticIdToken);

    const formats = resolveFormats(parsed.formatValues, resolveInputFormat(loadedInputs), parsed.locale);
    const files = buildOutputPlan(normalized.accounts, formats, {
      outputModes: effectiveOutputModes(parsed.outputModes, parsed.textMode),
      allowSyntheticIdToken: parsed.allowSyntheticIdToken,
    });
    const serializedFiles = serializeOutputFiles(files, parsed.textMode);

    if (parsed.inspect) {
      return info(inspectSummary(normalized, parsed.locale, parsed.allowSyntheticIdToken));
    }

    const outputRoot = path.resolve(cwd, parsed.outDir);
    const zipName = parsed.zip ? zipDownloadName(normalized.accounts) : undefined;

    if (parsed.dryRun) {
      return info(dryRunSummary(
        normalized.accounts.length,
        zipName ? [{ path: zipName, accountCount: normalized.accounts.length }] : serializedFiles,
        visibleWarnings,
        outputRoot,
        parsed.locale,
      ));
    }

    if (parsed.stdout) {
      if (formats.length !== 1 || serializedFiles.length !== 1) {
        return fail(2, [messages.errors.stdoutSingleFile]);
      }
      return {
        exitCode: 0,
        stdout: serializedFiles[0].text,
        stderr: humanSummary(normalized.accounts.length, serializedFiles.length, formats, visibleWarnings, undefined, parsed.locale),
      };
    }

    if (zipName) {
      const targetPath = path.join(outputRoot, zipName);
      if (!parsed.force) {
        await assertTargetAvailable(targetPath, parsed.locale);
      }
      await mkdir(outputRoot, { recursive: true });
      await writeFile(targetPath, zipOutputFiles(serializedFiles));
      return {
        exitCode: 0,
        stdout: "",
        stderr: humanSummary(normalized.accounts.length, 1, formats, visibleWarnings, outputRoot, parsed.locale),
      };
    }

    if (!parsed.force) {
      await assertTargetsAvailable(outputRoot, serializedFiles, parsed.locale);
    }

    for (const file of serializedFiles) {
      const targetPath = path.join(outputRoot, file.path);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.text, "utf8");
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: humanSummary(normalized.accounts.length, serializedFiles.length, formats, visibleWarnings, outputRoot, parsed.locale),
    };
  } catch (error) {
    if (error instanceof CliError) {
      return fail(error.exitCode, [error.message]);
    }
    if (isNodeIoError(error)) {
      return fail(3, [nodeIoMessage(error, locale)]);
    }
    const msg = error instanceof Error
      ? (process.env.DEBUG ? (error.stack ?? error.message) : error.message)
      : String(error);
    return fail(2, [msg]);
  }
}

function currentWorkingDirectory(locale: Locale): string {
  try {
    return process.cwd();
  } catch (error) {
    if (isNodeIoError(error) && error.code === "ENOENT") {
      throw new CliError(3, messagesFor(locale).cli.errors.cwdMissing);
    }
    throw error;
  }
}

function parseArgs(args: string[], locale: Locale): ParsedArgs {
  const messages = messagesFor(locale).cli;
  const parsed: ParsedArgs = {
    inputPaths: [],
    stdin: false,
    formatValues: [],
    outDir: "output",
    outDirSpecified: false,
    outputModes: {},
    textMode: "json",
    stdout: false,
    zip: false,
    allowSyntheticIdToken: true,
    locale,
    inspect: false,
    dryRun: false,
    force: false,
    serve: false,
    serveHost: "127.0.0.1",
    servePort: 8787,
    serveListenSpecified: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-i":
      case "--input":
        index += 1;
        addInputPath(parsed, requireValue(args, index, arg, locale), arg);
        break;
      case "-f":
      case "--format":
        index += 1;
        parsed.formatValues.push(requireValue(args, index, arg, locale));
        break;
      case "-o":
      case "--out-dir":
        index += 1;
        parsed.outDir = requireValue(args, index, arg, locale);
        parsed.outDirSpecified = true;
        break;
      case "--mode":
        index += 1;
        setOutputMode(parsed, requireValue(args, index, arg, locale));
        break;
      case "--stdout":
        parsed.stdout = true;
        break;
      case "--zip":
        parsed.zip = true;
        break;
      case "--no-fake-id":
        parsed.allowSyntheticIdToken = false;
        break;
      case "--stdin":
        setStdinInput(parsed);
        break;
      case "--lang":
        index += 1;
        parsed.locale = requireLocale(requireValue(args, index, arg, locale), locale);
        break;
      case "--inspect":
        parsed.inspect = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--serve":
        parsed.serve = true;
        break;
      case "--listen": {
        index += 1;
        const listen = parseListen(requireValue(args, index, arg, locale), locale);
        parsed.serveHost = listen.host;
        parsed.servePort = listen.port;
        parsed.serveListenSpecified = true;
        break;
      }
      case "--jsonl":
        parsed.textMode = "jsonl";
        break;
      case "--help":
        parsed.help = true;
        break;
      case "--version":
        parsed.version = true;
        break;
      default:
        if (arg.startsWith("--lang=")) {
          parsed.locale = requireLocale(arg.slice("--lang=".length), locale);
          break;
        }
        if (arg.startsWith("--listen=")) {
          const listen = parseListen(arg.slice("--listen=".length), locale);
          parsed.serveHost = listen.host;
          parsed.servePort = listen.port;
          parsed.serveListenSpecified = true;
          break;
        }
        if (!arg.startsWith("-")) {
          addInputPath(parsed, arg, messages.inputPathSource);
          break;
        }
        throw new Error(messages.errors.unknownArg(arg));
    }
  }

  return parsed;
}

function validateParsedArgs(parsed: ParsedArgs): void {
  const messages = messagesFor(parsed.locale).cli;
  if (parsed.serve) {
    const hasConversionOption =
      parsed.inputPaths.length > 0 ||
      parsed.stdin ||
      parsed.formatValues.length > 0 ||
      parsed.outDirSpecified ||
      parsed.stdout ||
      parsed.zip ||
      parsed.inspect ||
      parsed.dryRun ||
      parsed.force ||
      parsed.textMode !== "json" ||
      !parsed.allowSyntheticIdToken ||
      Object.keys(parsed.outputModes).length > 0;
    if (hasConversionOption) {
      throw new CliError(2, messages.errors.serveConflict);
    }
    return;
  }
  if (parsed.serveListenSpecified && !parsed.serve) {
    throw new CliError(2, messages.errors.serveOptionWithoutServe);
  }
  if (parsed.inspect && (parsed.stdout || parsed.outDirSpecified || parsed.zip)) {
    throw new CliError(2, messages.errors.inspectTargetConflict);
  }
  if (parsed.inspect && parsed.dryRun) {
    throw new CliError(2, messages.errors.inspectDryRunConflict);
  }
  if (parsed.dryRun && parsed.stdout) {
    throw new CliError(2, messages.errors.dryRunStdoutConflict);
  }
  if (parsed.zip && parsed.stdout) {
    throw new CliError(2, messages.errors.zipStdoutConflict);
  }
  if (parsed.inputPaths.length === 0 && !parsed.stdin) {
    throw new CliError(2, messages.errors.missingInput);
  }
}

function setOutputMode(parsed: ParsedArgs, value: string): void {
  const messages = messagesFor(parsed.locale).cli;
  const [format, mode, extra] = value.split("=");
  if (!format || !mode || extra !== undefined) {
    throw new CliError(2, messages.errors.invalidModeSyntax(value));
  }
  if (!isOutputFormat(format)) {
    throw new CliError(2, messages.errors.unknownOutputFormat(format));
  }
  if (!isMergeableFormat(format)) {
    throw new CliError(2, messages.errors.unsupportedModeFormat(format));
  }
  if (!isOutputMode(mode)) {
    throw new CliError(2, messages.errors.unknownOutputMode(mode));
  }
  parsed.outputModes[format] = mode;
}

function addInputPath(parsed: ParsedArgs, inputPath: string, source: string): void {
  if (parsed.stdin) {
    throw new Error(messagesFor(parsed.locale).cli.errors.stdinConflict(source));
  }
  parsed.inputPaths.push(inputPath);
}

function setStdinInput(parsed: ParsedArgs): void {
  if (parsed.inputPaths.length > 0) {
    throw new Error(messagesFor(parsed.locale).cli.errors.stdinPathConflict);
  }
  parsed.stdin = true;
}

function requireValue(args: string[], index: number, flag: string, locale: Locale): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(messagesFor(locale).cli.errors.missingFlagValue(flag));
  }
  return value;
}

function scanLocaleArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--lang") {
      return args[index + 1];
    }
    if (arg.startsWith("--lang=")) {
      return arg.slice("--lang=".length);
    }
  }
  return undefined;
}

function requireLocale(value: string, messageLocale: Locale): Locale {
  const locale = normalizeLocale(value);
  if (!locale) {
    throw new Error(messagesFor(messageLocale).cli.errors.invalidLang(value));
  }
  return locale;
}

function parseListen(value: string, locale: Locale): { host: string; port: number } {
  const trimmed = value.trim();
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: requirePort(bracketMatch[2], locale),
    };
  }

  const separatorIndex = trimmed.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(messagesFor(locale).cli.errors.invalidListen(value));
  }

  return {
    host: trimmed.slice(0, separatorIndex),
    port: requirePort(trimmed.slice(separatorIndex + 1), locale),
  };
}

function requirePort(value: string, locale: Locale): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(messagesFor(locale).cli.errors.invalidPort(value));
  }
  return port;
}

export async function startWebUiServer(options: {
  host?: string;
  port?: number;
  indexPath?: string;
} = {}): Promise<WebUiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const indexPath = options.indexPath ?? defaultWebUiIndexPath();
  const server = createServer(async (request, response) => {
    const pathname = request.url ? new URL(request.url, "http://authconv.local").pathname : "/";
    if (request.method !== "GET" && request.method !== "HEAD") {
      writePlainResponse(response, 405, "Method Not Allowed");
      return;
    }
    if (pathname !== "/" && pathname !== "/index.html") {
      writePlainResponse(response, 404, "Not Found");
      return;
    }

    try {
      const html = await readFile(indexPath, "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch (error) {
      writePlainResponse(response, 500, error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const actualPort = serverPort(server) ?? port;
  return {
    host,
    port: actualPort,
    url: `http://${urlHost(host)}:${actualPort}/`,
    close: () => closeServer(server),
  };
}

function defaultWebUiIndexPath(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(scriptDir, "index.html"),
    path.join(scriptDir, "..", "dist", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function serverPort(server: Server): number | undefined {
  const address = server.address();
  return typeof address === "object" && address ? address.port : undefined;
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function writePlainResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${body}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readInputs(inputPaths: string[], useStdin: boolean, locale: Locale, io: CliIo): Promise<LoadedInput[]> {
  if (useStdin) {
    const text = io.stdin !== undefined ? io.stdin : await readStdin();
    return [parseInputText(text, "stdin", "stdin", locale)];
  }

  const inputGroups = await Promise.all(inputPaths.map((inputPath) => readInputPath(inputPath, locale)));
  return inputGroups.flat();
}

async function readInputPath(inputPath: string, locale: Locale): Promise<LoadedInput[]> {
  const messages = messagesFor(locale).cli;
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && isJsonInputFile(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    if (files.length === 0) {
      throw new CliError(3, messages.errors.noInputFiles(inputPath));
    }

    return Promise.all(
      files.map(async (fileName) => {
        const sourcePath = path.join(inputPath, fileName);
        return parseInputText(await readFile(sourcePath, "utf8"), fileName, sourcePath, locale);
      }),
    );
  }

  if (!inputStat.isFile()) {
    throw new CliError(3, messages.errors.notFileOrDirectory(inputPath));
  }

  return [parseInputText(await readFile(inputPath, "utf8"), path.basename(inputPath), inputPath, locale)];
}

function isJsonInputFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".json") || lowerName.endsWith(".jsonl");
}

function parseInputText(text: string, sourceName: string, sourcePath: string, locale: Locale): LoadedInput {
  let input: unknown;
  try {
    input = parseInputPayload(text, { locale });
  } catch (error) {
    throw new Error(
      `${sourceName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    input,
    sourceName,
    sourcePath,
    inputFormat: detectInputFormat(input),
  };
}

function normalizeLoadedInputs(inputs: LoadedInput[], options: NormalizeOptions): NormalizeResult {
  const results = inputs.map((item) =>
    normalizeInput(item.input, {
      sourceName: item.sourceName,
      sourcePath: item.sourcePath,
    }, options),
  );
  const allAccounts = results.flatMap((result) => result.accounts);
  const dedupedAccounts = dedupeAccounts(allAccounts);
  return {
    accounts: dedupedAccounts,
    warnings: results.flatMap((result) => result.warnings),
    inputFormat: resolveInputFormat(inputs),
  };
}

function resolveInputFormat(inputs: LoadedInput[]): InputFormat {
  return inputs.length > 0 && inputs.every((input) => input.inputFormat === "sub2api")
    ? "sub2api"
    : "unknown";
}

function resolveFormats(values: string[], inputFormat: InputFormat, locale: Locale): OutputFormat[] {
  if (values.length > 0) {
    return parseFormatList(values, {
      invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat,
    });
  }
  return parseFormatList(["all"], {
    invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat,
  });
}

function groupWarnings(warnings: string[], locale: Locale): string[] {
  const messages = messagesFor(locale).cli.summary;
  const grouped = new Map<string, string[]>();

  for (const warning of warnings) {
    const match = warning.match(/^(.+?):\s*(.+)$/);
    if (!match) {
      const list = grouped.get(warning) || [];
      grouped.set(warning, list);
      continue;
    }
    const [, source, msg] = match;
    const list = grouped.get(msg) || [];
    list.push(source);
    grouped.set(msg, list);
  }

  return Array.from(grouped.entries()).map(([msg, sources]) => {
    if (sources.length === 0) return msg;
    if (sources.length === 1) return `${sources[0]}: ${msg}`;
    return messages.groupedWarnings(msg, sources);
  });
}

function outputWarnings(result: NormalizeResult, locale: Locale, allowSyntheticIdToken: boolean): string[] {
  if (allowSyntheticIdToken) {
    return result.warnings;
  }

  const normalizeMessages = messagesFor(locale).normalize;
  const syntheticWarnings = new Set(
    result.accounts
      .filter((account) => account.idTokenSynthetic)
      .map((account) => normalizeMessages.syntheticIdToken(account.sourceName)),
  );
  return result.warnings.filter((warning) => !syntheticWarnings.has(warning));
}

function humanSummary(accountCount: number, fileCount: number, formats: OutputFormat[], warnings: string[], outputRoot: string | undefined, locale: Locale): string {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  const lines = [messages.human(accountCount, fileCount, formatLabels, outputRoot)];
  for (const warning of groupWarnings(warnings, locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function inspectSummary(result: NormalizeResult, locale: Locale, allowSyntheticIdToken: boolean): string {
  const messages = messagesFor(locale).cli.summary;
  const header = messages.inspectColumns;
  const rows = result.accounts.map((account, index) => [
    String(index + 1),
    account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? messages.unknownAccount,
    account.accountId ?? account.chatgptAccountId ?? messages.missingValue,
    account.planType ?? messages.missingValue,
    displayDate(account.expiresAt),
  ]);
  const widths = header.map((cell, col) =>
    Math.max(cell.length, ...rows.map((row) => row[col].length)),
  );
  const formatRow = (cells: string[]) =>
    cells.map((cell, col) => cell.padEnd(widths[col], " ")).join("  ").trimEnd();
  const lines = [formatRow(header), ...rows.map(formatRow)];
  for (const warning of groupWarnings(outputWarnings(result, locale, allowSyntheticIdToken), locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function dryRunSummary(
  accountCount: number,
  files: Array<Pick<SerializedOutputFile, "path" | "accountCount">>,
  warnings: string[],
  outputRoot: string,
  locale: Locale,
): string {
  const messages = messagesFor(locale).cli.summary;
  const lines = [messages.dryRun(accountCount, files.length, outputRoot)];
  for (const file of files) {
    lines.push(messages.fileLine(file.path, file.accountCount));
  }
  for (const warning of groupWarnings(warnings, locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

async function assertTargetsAvailable(outputRoot: string, files: SerializedOutputFile[], locale: Locale): Promise<void> {
  for (const file of files) {
    await assertTargetAvailable(path.join(outputRoot, file.path), locale);
  }
}

async function assertTargetAvailable(targetPath: string, locale: Locale): Promise<void> {
  const messages = messagesFor(locale).cli;
  if (await pathExists(targetPath)) {
    throw new CliError(3, messages.errors.alreadyExists(targetPath));
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (isNodeIoError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function displayDate(value: string | undefined): string {
  return value?.slice(0, 10) || "—";
}

function isOutputMode(value: string): value is OutputMode {
  return value === "merged" || value === "single";
}

function isMergeableFormat(format: OutputFormat): boolean {
  return format === "sub2api" || format === "codex2api";
}

function isNodeIoError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function nodeIoMessage(error: NodeJS.ErrnoException, locale: Locale): string {
  const target = error.path ? String(error.path) : "IO";
  if (error.code === "ENOENT") {
    return messagesFor(locale).cli.errors.notFound(target);
  }
  return error.message;
}

function fail(exitCode: number, messages: string[]): CliResult {
  return {
    exitCode,
    stdout: "",
    stderr: `${messages.join("\n")}\n`,
  };
}

function info(stderr: string): CliResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function helpText(locale: Locale): string {
  return messagesFor(locale).cli.help(VERSION);
}

function isMain(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const calledPath = path.resolve(process.argv[1]);
  let realCalled: string;
  try {
    realCalled = realpathSync(calledPath);
  } catch {
    realCalled = calledPath;
  }
  return scriptPath === calledPath || scriptPath === realCalled;
}

if (isMain()) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
