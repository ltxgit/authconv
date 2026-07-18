import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, type FileHandle } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { AccountStore } from "./account-store.js";
import { detectCliLocale, FORMAT_LABELS, messagesFor, normalizeLocale } from "./i18n.js";
import { ingestSources, type IngestionProgress } from "./ingestion.js";
import { parseNodeJsonTokens } from "./input-node.js";
import { zipDownloadName } from "./download-names.js";
import { isConfigurableOutputFormat, isOutputFormat, parseFormatList } from "./formats.js";
import {
  buildExportManifest,
  streamExport,
  type ExportManifest,
  type ExportSink,
  type ExportWriter,
} from "./output.js";
import type {
  IngestionDiagnostic,
  InputSource,
  Locale,
  NormalizedAccount,
  OutputFormat,
  OutputMode,
  OutputModes,
  OutputTextMode,
  TokenVerificationReason,
  TokenVerificationStatus,
} from "./types.js";

declare const __AUTHCONV_VERSION__: string | undefined;
const VERSION = typeof __AUTHCONV_VERSION__ === "string" && __AUTHCONV_VERSION__.trim()
  ? __AUTHCONV_VERSION__.trim()
  : packageJson.version;

export type CliIo = {
  stdin?: string;
  cwd?: string;
  writeStdout?: (chunk: Uint8Array) => void | Promise<void>;
  writeStderr?: (text: string) => void;
  stderrIsTTY?: boolean;
  handleSignals?: boolean;
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
  includeRefreshToken: boolean;
  verifyTokens: boolean;
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
  let stopSignalHandling = () => undefined;
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
    const abortController = new AbortController();
    const onSigint = () => abortController.abort(new DOMException("Interrupted", "AbortError"));
    if (io.handleSignals) {
      process.once("SIGINT", onSigint);
      stopSignalHandling = () => { process.off("SIGINT", onSigint); };
    }
    const sources = await discoverInputSources(
      inputPaths,
      parsed.stdin,
      parsed.locale,
      io,
      abortController.signal,
    );
    const store = new AccountStore();
    const ingestion = await ingestSources(sources, store, {
      parseTokens: parseNodeJsonTokens,
      signal: abortController.signal,
      verifyTokens: parsed.verifyTokens,
      onProgress: progressReporter(io, parsed.locale),
    });
    finishProgress(io);

    const diagnosticLines = ingestion.diagnostics.map((diagnostic) => diagnosticMessage(diagnostic, parsed.locale));
    if (store.size === 0) {
      return fail(1, [messages.errors.noAccounts, ...diagnosticLines]);
    }
    const formats = resolveFormats(parsed.formatValues, parsed.locale);
    const manifest = buildExportManifest(store, {
      formats,
      outputModes: parsed.outputModes,
      textMode: parsed.textMode,
      forceZip: parsed.zip,
      verifyTokens: parsed.verifyTokens,
    });
    const verificationLines = verificationRejectionLines(manifest, parsed.locale);
    const resultLines = [...diagnosticLines, ...verificationLines];
    const successExitCode = ingestion.diagnostics.length > 0 || manifest.rejectedAccountCount > 0 ? 1 : 0;

    if (parsed.inspect) {
      return info(appendDiagnostics(inspectSummary(store, parsed.locale), resultLines), successExitCode);
    }

    if (manifest.entries.length === 0) {
      const noOutput = manifest.rejectedAccountCount > 0
        ? (parsed.locale === "zh" ? "没有通过 token 验证的可输出账号" : "No accounts passed token verification")
        : messages.errors.noApplicableFormats;
      return fail(1, [noOutput, ...resultLines]);
    }

    const outputRoot = path.resolve(cwd, parsed.outDir);
    const exportAccounts = accountsFromManifest(store, manifest);
    const zipName = parsed.zip ? zipDownloadName(exportAccounts) : undefined;

    if (parsed.dryRun) {
      return info(appendDiagnostics(dryRunSummary(
        manifest.accountCount,
        zipName ? [{ path: zipName, accountCount: manifest.accountCount }] : manifest.entries,
        outputRoot,
        parsed.locale,
      ), resultLines), successExitCode);
    }

    if (parsed.stdout) {
      if (manifest.formats.length !== 1 || manifest.entries.length !== 1 || manifest.archive) {
        return fail(2, [messages.errors.stdoutSingleFile]);
      }
      const chunks: Uint8Array[] = [];
      await streamExport(store, manifest, stdoutSink(io, chunks), {
        signal: abortController.signal,
        allowSyntheticIdToken: parsed.allowSyntheticIdToken,
        includeRefreshToken: parsed.includeRefreshToken,
      });
      return {
        exitCode: successExitCode,
        stdout: io.writeStdout ? "" : new TextDecoder().decode(concatBytes(chunks)),
        stderr: appendDiagnostics(
          humanSummary(manifest.accountCount, manifest.entries.length, manifest.formats, undefined, parsed.locale),
          resultLines,
        ),
      };
    }

    if (zipName) {
      const targetPath = path.join(outputRoot, zipName);
      if (!parsed.force) {
        await assertTargetAvailable(targetPath, parsed.locale);
      }
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      await streamExport(store, manifest, fileSink(outputRoot, targetPath, parsed.force), {
        signal: abortController.signal,
        allowSyntheticIdToken: parsed.allowSyntheticIdToken,
        includeRefreshToken: parsed.includeRefreshToken,
        onProgress: exportProgressReporter(io, parsed.locale),
      });
      finishProgress(io);
      return {
        exitCode: successExitCode,
        stdout: "",
        stderr: appendDiagnostics(
          fileSummary(manifest.accountCount, manifest.formats, targetPath, parsed.locale),
          resultLines,
        ),
      };
    }

    if (!parsed.force) {
      await assertTargetsAvailable(outputRoot, manifest, parsed.locale);
    }
    await streamExport(store, manifest, fileSink(outputRoot, undefined, parsed.force), {
      signal: abortController.signal,
      allowSyntheticIdToken: parsed.allowSyntheticIdToken,
      includeRefreshToken: parsed.includeRefreshToken,
      onProgress: exportProgressReporter(io, parsed.locale),
    });
    finishProgress(io);

    const singleTargetPath = manifest.entries.length === 1
      ? path.join(outputRoot, manifest.entries[0].path)
      : undefined;
    return {
      exitCode: successExitCode,
      stdout: "",
      stderr: appendDiagnostics(
        singleTargetPath
          ? fileSummary(manifest.accountCount, manifest.formats, singleTargetPath, parsed.locale)
          : humanSummary(manifest.accountCount, manifest.entries.length, manifest.formats, outputRoot, parsed.locale),
        resultLines,
      ),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return fail(130, [locale === "zh" ? "操作已取消" : "Operation cancelled"]);
    }
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
  } finally {
    stopSignalHandling();
    finishProgress(io);
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
    includeRefreshToken: true,
    verifyTokens: true,
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
      case "--no-refresh-token":
        parsed.includeRefreshToken = false;
        break;
      case "--no-verify-token":
        parsed.verifyTokens = false;
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
      !parsed.includeRefreshToken ||
      !parsed.verifyTokens ||
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
  if (!isConfigurableOutputFormat(format)) {
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
  return path.join(scriptDir, "index.html");
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

async function discoverInputSources(
  inputPaths: string[],
  useStdin: boolean,
  locale: Locale,
  io: CliIo,
  signal: AbortSignal,
): Promise<InputSource[]> {
  if (useStdin) {
    return [{
      name: "stdin",
      path: "stdin",
      chunks: io.stdin !== undefined ? textChunks(io.stdin) : processStdinChunks(signal),
    }];
  }

  const discovered: string[] = [];
  for (const inputPath of inputPaths) {
    throwIfAborted(signal);
    const inputStat = await stat(inputPath);
    throwIfAborted(signal);
    if (inputStat.isDirectory()) {
      const files = await discoverDirectoryFiles(inputPath, signal);
      if (files.length === 0) {
        throw new CliError(3, messagesFor(locale).cli.errors.noInputFiles(inputPath));
      }
      for (const file of files) discovered.push(file);
      continue;
    }
    if (!inputStat.isFile()) {
      throw new CliError(3, messagesFor(locale).cli.errors.notFileOrDirectory(inputPath));
    }
    discovered.push(inputPath);
  }

  return discovered.map((sourcePath) => {
    const content = fileChunkSource(sourcePath, signal);
    return {
      name: path.basename(sourcePath),
      path: sourcePath,
      ...content,
    };
  });
}

export async function discoverDirectoryFiles(directory: string, signal: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  throwIfAborted(signal);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await discoverDirectoryFiles(entryPath, signal);
      for (const file of nestedFiles) files.push(file);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function fileChunkSource(
  sourcePath: string,
  signal: AbortSignal,
): {
  chunks: AsyncIterable<Uint8Array>;
  cancel: (reason?: unknown) => void;
} {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let cancelled = false;
  let cancelReason: unknown;
  return {
    chunks: (async function* () {
      const current = createReadStream(sourcePath);
      stream = current;
      const abort = () => current.destroy(abortError(signal));
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (cancelled) current.destroy(asError(cancelReason));
        for await (const chunk of current) {
          if (signal.aborted) throw abortError(signal);
          if (cancelled) return;
          yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        current.destroy();
        if (stream === current) stream = undefined;
      }
    })(),
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      stream?.destroy(asError(reason));
    },
  };
}

async function* textChunks(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function* processStdinChunks(signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const abort = () => process.stdin.destroy(abortError(signal));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of process.stdin) {
      if (signal.aborted) throw abortError(signal);
      yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? "Cancelled"));
}

function resolveFormats(values: string[], locale: Locale): OutputFormat[] {
  if (values.length > 0) {
    return parseFormatList(values, {
      invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat,
    });
  }
  return parseFormatList(["all"], {
    invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat,
  });
}

function humanSummary(
  accountCount: number,
  fileCount: number,
  formats: OutputFormat[],
  outputRoot: string | undefined,
  locale: Locale,
): string {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  return `${messages.human(accountCount, fileCount, formats.length, formatLabels, outputRoot)}\n`;
}

function fileSummary(
  accountCount: number,
  formats: OutputFormat[],
  targetPath: string,
  locale: Locale,
): string {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  return `${messages.humanFile(accountCount, formats.length, formatLabels, targetPath)}\n`;
}

function appendDiagnostics(summary: string, diagnostics: string[]): string {
  if (diagnostics.length === 0) {
    return summary;
  }
  const prefix = summary.endsWith("\n") ? summary : `${summary}\n`;
  return `${prefix}${diagnostics.join("\n")}\n`;
}

function inspectSummary(store: AccountStore, locale: Locale): string {
  const messages = messagesFor(locale).cli.summary;
  const header = [...messages.inspectColumns, locale === "zh" ? "验真" : "Verification"];
  const rows = [...store.values()].map((account, index) => {
    const openAi = account.provider === "openai" ? account : undefined;
    return [
      String(index + 1),
      account.email ?? account.name ?? openAi?.chatgptAccountId ?? openAi?.accountId ?? account.userId ?? messages.unknownAccount,
      openAi?.accountId ?? openAi?.chatgptAccountId ?? messages.missingValue,
      openAi?.planType ?? messages.missingValue,
      displayDate(account.expiresAt),
      verificationDisplay(
        account.tokenVerification?.status,
        account.tokenVerification?.reason,
        account.tokenVerification?.notBeforeActive,
        locale,
      ),
    ];
  });
  const widths = header.map((cell) => cell.length);
  for (const row of rows) {
    for (let col = 0; col < row.length; col += 1) {
      widths[col] = Math.max(widths[col], row[col].length);
    }
  }
  const formatRow = (cells: string[]) =>
    cells.map((cell, col) => cell.padEnd(widths[col], " ")).join("  ").trimEnd();
  const counts = store.summary().verificationCounts;
  const verificationLine = locale === "zh"
    ? `验真统计：真实 ${counts.verified}，伪造 ${counts.forged}，不可验证 ${counts.unverifiable}，未检查 ${counts.unchecked}`
    : `Verification: ${counts.verified} verified, ${counts.forged} forged, ${counts.unverifiable} unverifiable, ${counts.unchecked} unchecked`;
  const lines = [formatRow(header), ...rows.map(formatRow), verificationLine];
  return `${lines.join("\n")}\n`;
}

function verificationRejectionLines(manifest: ExportManifest, locale: Locale): string[] {
  if (manifest.rejectedAccountCount === 0) return [];
  const details = Object.entries(manifest.rejectionReasons)
    .filter((entry): entry is [TokenVerificationReason, number] => typeof entry[1] === "number")
    .map(([reason, count]) => `${verificationReasonLabel(reason, locale)}: ${count}`)
    .join(locale === "zh" ? "，" : ", ");
  const prefix = locale === "zh"
    ? `token 验证拒绝 ${manifest.rejectedAccountCount} 个账号`
    : `Token verification rejected ${manifest.rejectedAccountCount} account${manifest.rejectedAccountCount === 1 ? "" : "s"}`;
  return [`${prefix}${details ? `: ${details}` : ""}`];
}

function verificationDisplay(
  status: TokenVerificationStatus | undefined,
  reason: TokenVerificationReason | undefined,
  notBeforeActive: true | undefined,
  locale: Locale,
): string {
  if (!status || !reason) return locale === "zh" ? "缺失" : "missing";
  const statusLabels: Record<TokenVerificationStatus, [string, string]> = {
    verified: ["真实", "verified"],
    forged: ["伪造", "forged"],
    unverifiable: ["不可验证", "unverifiable"],
    unchecked: ["未检查", "unchecked"],
  };
  const notBefore = notBeforeActive
    ? (locale === "zh" ? "，尚未生效" : ", not active yet")
    : "";
  return `${statusLabels[status][locale === "zh" ? 0 : 1]} (${verificationReasonLabel(reason, locale)}${notBefore})`;
}

function verificationReasonLabel(reason: TokenVerificationReason, locale: Locale): string {
  const labels: Record<TokenVerificationReason, [string, string]> = {
    signature_valid: ["签名有效", "valid signature"],
    malformed_jwt: ["JWT 格式损坏", "malformed JWT"],
    algorithm_rejected: ["算法不允许", "rejected algorithm"],
    signature_failed: ["签名失败", "signature failed"],
    issuer_mismatch: ["issuer 不匹配", "issuer mismatch"],
    audience_mismatch: ["audience 不匹配", "audience mismatch"],
    token_type_mismatch: ["token 类型不匹配", "token type mismatch"],
    missing_access_token: ["缺少 access token", "missing access token"],
    opaque_access_token: ["opaque access token", "opaque access token"],
    unknown_kid: ["未知 kid", "unknown kid"],
    unknown_provider: ["未知平台", "unknown provider"],
    user_disabled: ["用户关闭验证", "verification disabled"],
    verification_missing: ["缺少验真结果", "missing verification result"],
  };
  return labels[reason][locale === "zh" ? 0 : 1];
}

function accountsFromManifest(store: AccountStore, manifest: ExportManifest): NormalizedAccount[] {
  const accounts: NormalizedAccount[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    for (const id of entry.accountIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const account = store.get(id);
      if (account) accounts.push(account);
    }
  }
  return accounts;
}

function dryRunSummary(
  accountCount: number,
  files: Array<{ path: string; accountCount: number }>,
  outputRoot: string,
  locale: Locale,
): string {
  const messages = messagesFor(locale).cli.summary;
  const lines = [messages.dryRun(accountCount, files.length, outputRoot)];
  if (files.length === 1) {
    const [file] = files;
    lines.push(messages.fileLine(file.path, file.accountCount));
  }
  return `${lines.join("\n")}\n`;
}

async function assertTargetsAvailable(outputRoot: string, manifest: ExportManifest, locale: Locale): Promise<void> {
  for (const entry of manifest.entries) {
    await assertTargetAvailable(path.join(outputRoot, entry.path), locale);
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

function fileSink(outputRoot: string, archivePath: string | undefined, force: boolean): ExportSink {
  return {
    openFile: async (relativePath) => openFileWriter(path.join(outputRoot, relativePath), force),
    openArchive: async () => {
      if (!archivePath) throw new Error("Archive target is not configured");
      return openFileWriter(archivePath, force);
    },
  };
}

async function openFileWriter(targetPath: string, force: boolean): Promise<ExportWriter> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const handle = await open(targetPath, force ? "w" : "wx", 0o600);
  return createFileWriter(handle);
}

export function createFileWriter(handle: Pick<FileHandle, "write" | "close">): ExportWriter {
  let position = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    await handle.close();
    closed = true;
  };
  return {
    write: async (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, position);
        offset += result.bytesWritten;
        position += result.bytesWritten;
      }
    },
    close,
    abort: close,
  };
}

function stdoutSink(io: CliIo, collected: Uint8Array[]): ExportSink {
  const writer: ExportWriter = {
    write: async (chunk) => {
      if (io.writeStdout) await io.writeStdout(chunk);
      else collected.push(chunk.slice());
    },
    close: () => undefined,
    abort: () => undefined,
  };
  return {
    openFile: async () => writer,
    openArchive: async () => writer,
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function progressReporter(io: CliIo, locale: Locale) {
  let last = 0;
  let lastPhase: IngestionProgress["phase"] | undefined;
  return (progress: IngestionProgress) => {
    if (!io.stderrIsTTY || !io.writeStderr) return;
    const now = Date.now();
    if (now - last < 100 && progress.phase === lastPhase) return;
    last = now;
    lastPhase = progress.phase;
    if (progress.phase === "verify") {
      const label = locale === "zh" ? "验真" : "Verify";
      io.writeStderr(`\r${label}: ${progress.verifiedCandidates}/${progress.processedCandidates}`);
      return;
    }
    const label = locale === "zh" ? "导入" : "Import";
    io.writeStderr(`\r${label}: ${progress.processedCandidates} / ${progress.storedAccounts}`);
  };
}

function exportProgressReporter(io: CliIo, locale: Locale) {
  let last = 0;
  return (progress: { completedEntries: number; totalEntries: number; completedAccounts: number }) => {
    if (!io.stderrIsTTY || !io.writeStderr) return;
    const now = Date.now();
    if (now - last < 100 && progress.completedEntries < progress.totalEntries) return;
    last = now;
    const label = locale === "zh" ? "导出" : "Export";
    io.writeStderr(`\r${label}: ${progress.completedEntries}/${progress.totalEntries} (${progress.completedAccounts})`);
  };
}

function finishProgress(io: CliIo): void {
  if (io.stderrIsTTY && io.writeStderr) io.writeStderr("\r\u001b[2K");
}

function diagnosticMessage(diagnostic: IngestionDiagnostic, locale: Locale): string {
  const position = diagnostic.line ? `${locale === "zh" ? "第" : "line "}${diagnostic.line}${locale === "zh" ? " 行" : ""}` : "";
  const label: Record<IngestionDiagnostic["code"], [string, string]> = {
    json_parse_failed: ["JSON 解析失败", "JSON parse failed"],
    zip_read_failed: ["ZIP 解压失败", "ZIP extraction failed"],
    input_format_mismatch: ["输入格式不匹配", "Input format mismatch"],
    no_credential_tokens: ["没有可用凭证字段", "No credential tokens"],
    unsupported_input: ["不支持的输入", "Unsupported input"],
  };
  const text = label[diagnostic.code][locale === "zh" ? 0 : 1];
  return [diagnostic.sourceName, position, text, diagnostic.detail].filter(Boolean).join(": ");
}

function displayDate(value: string | undefined): string {
  return value?.slice(0, 10) || "—";
}

function isOutputMode(value: string): value is OutputMode {
  return value === "merged" || value === "single";
}

function isNodeIoError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string";
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

function info(stderr: string, exitCode = 0): CliResult {
  return {
    exitCode,
    stdout: "",
    stderr,
  };
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
  const result = await runCli(process.argv.slice(2), {
    writeStdout: (chunk) => writeStreamChunk(process.stdout, chunk),
    writeStderr: (text) => process.stderr.write(text),
    stderrIsTTY: process.stderr.isTTY,
    handleSignals: true,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

export function writeStreamChunk(stream: NodeJS.WriteStream, chunk: Uint8Array): Promise<void> | void {
  if (stream.write(chunk)) return;
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}
