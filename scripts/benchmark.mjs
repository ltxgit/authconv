import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_MEDIAN_LIMIT_MS = 100;
const MAIN_THREAD_DISPATCH_LIMIT_MS = 50;
const WORKLOAD_METRICS = ["accounts", "entries", "bytes"];
const options = parseArgs(process.argv.slice(2));
const workDir = await mkdtemp(join(tmpdir(), "authconv-benchmark-"));
const runner = join(workDir, "runner.mjs");
const syntheticFile = join(workDir, `synthetic-${options.accounts}.json`);

try {
  await esbuild.build({
    entryPoints: [resolve(root, "scripts/benchmark-runner.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: runner,
    logLevel: "silent",
  });

  const modes = options.modes ?? ["parse", "ingestion", "search", "single", "merged", "jsonl", "zip", "worker"];
  const rows = [];
  for (const mode of modes.filter((mode) => mode !== "cli")) {
    rows.push(await benchmarkMode(mode, options.iterations));
  }

  if (!options.modes || options.modes.includes("cli")) {
    await runRunner("generate", { AUTHCONV_BENCH_OUTPUT: syntheticFile });
    rows.push(await benchmarkCli("cli", syntheticFile, options.iterations));
  }
  if (options.realZip) {
    rows.push(await benchmarkMode("worker-real", options.iterations, { AUTHCONV_REAL_ZIP: options.realZip }));
    rows.push(await benchmarkCli("cli-real", options.realZip, options.iterations));
  }

  printResults(rows, options);
  enforceTargets(rows);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

async function benchmarkMode(mode, iterations, env = {}) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await runRunner(mode, env));
  }
  return summarize(mode, samples);
}

async function runRunner(mode, env = {}) {
  const result = await execute(process.execPath, ["--expose-gc", runner, mode], {
    ...process.env,
    AUTHCONV_BENCH_ACCOUNTS: String(options.accounts),
    ...env,
  });
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`Benchmark ${mode} returned no result`);
  return JSON.parse(line);
}

async function benchmarkCli(mode, inputPath, iterations) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    const result = await execute("/usr/bin/time", [
      ...(process.platform === "darwin" ? ["-l"] : ["-v"]),
      process.execPath,
      resolve(root, "dist/cli.mjs"),
      inputPath,
      "-f",
      "sub2api",
      "--dry-run",
      "--no-verify-token",
      "--lang",
      "en",
    ], process.env);
    const timeMs = performance.now() - started;
    samples.push({
      mode,
      timeMs,
      maxRssBytes: parseMaxRss(result.stderr),
      accounts: parseCliAccountCount(result.stderr),
    });
  }
  return summarize(mode, samples);
}

function summarize(mode, samples) {
  if (samples.length === 0) throw new Error(`Benchmark ${mode} produced no samples`);
  const times = samples.map((sample) => sample.timeMs).sort((left, right) => left - right);
  const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
  const variance = times.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / times.length;
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 === 0 ? (times[middle - 1] + times[middle]) / 2 : times[middle];
  const summary = {
    mode,
    minMs: times[0],
    maxMs: times.at(-1),
    meanMs: mean,
    medianMs: median,
    stddevMs: Math.sqrt(variance),
    peakRssBytes: samples.reduce((maximum, sample) => Math.max(maximum, sample.maxRssBytes), 0),
    mainThreadDispatchMs: samples.reduce(
      (maximum, sample) => Math.max(maximum, sample.mainThreadDispatchMs ?? 0),
      0,
    ),
  };
  for (const metric of WORKLOAD_METRICS) {
    const values = samples.map((sample) => sample[metric]);
    if (values.every((value) => value === undefined)) continue;
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Benchmark ${mode} produced an invalid ${metric}`);
    }
    summary[metric] = values[0];
  }
  return summary;
}

function printResults(rows, config) {
  console.log(`Auth Converter benchmark: ${config.accounts.toLocaleString()} synthetic accounts, ${config.iterations} iteration(s)`);
  console.log("mode          accounts  entries        bytes   min ms   median ms   mean ms   max ms   stddev   peak RSS MB   main dispatch ms");
  for (const row of rows) {
    console.log([
      row.mode.padEnd(13),
      formatInteger(row.accounts, 8),
      formatInteger(row.entries, 8),
      formatInteger(row.bytes, 12),
      format(row.minMs, 8),
      format(row.medianMs, 11),
      format(row.meanMs, 9),
      format(row.maxMs, 8),
      format(row.stddevMs, 8),
      format(row.peakRssBytes / 1024 / 1024, 13),
      format(row.mainThreadDispatchMs, 18),
    ].join(" "));
  }
}

function enforceTargets(rows) {
  for (const row of rows) {
    for (const metric of WORKLOAD_METRICS) {
      if (row[metric] !== undefined && row[metric] <= 0) {
        throw new Error(`Benchmark ${row.mode} produced empty ${metric}`);
      }
    }
  }
  const search = rows.find((row) => row.mode === "search");
  if (search && search.medianMs >= SEARCH_MEDIAN_LIMIT_MS) {
    throw new Error(`Search target missed: ${search.medianMs.toFixed(1)} ms >= ${SEARCH_MEDIAN_LIMIT_MS} ms`);
  }
  for (const worker of rows.filter((row) => row.mode === "worker" || row.mode === "worker-real")) {
    if (worker.mainThreadDispatchMs >= MAIN_THREAD_DISPATCH_LIMIT_MS) {
      throw new Error(
        `Main-thread target missed: ${worker.mainThreadDispatchMs.toFixed(1)} ms >= ${MAIN_THREAD_DISPATCH_LIMIT_MS} ms`,
      );
    }
  }
}

function parseMaxRss(stderr) {
  if (process.platform === "darwin") {
    const match = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m);
    if (match) return Number(match[1]);
  } else {
    const match = stderr.match(/^\s*Maximum resident set size \(kbytes\):\s*(\d+)$/m);
    if (match) return Number(match[1]) * 1024;
  }
  throw new Error("Unable to parse peak RSS from /usr/bin/time output");
}

function parseCliAccountCount(stderr) {
  const match = stderr.match(/Found ([\d,]+) accounts?, would write/);
  if (!match) throw new Error("Unable to parse CLI account count from dry-run output");
  return Number(match[1].replaceAll(",", ""));
}

function execute(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

function parseArgs(args) {
  const parsed = { accounts: 100_000, iterations: 3, realZip: undefined, modes: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--accounts") parsed.accounts = positiveInteger(args[++index], value);
    else if (value === "--iterations") parsed.iterations = positiveInteger(args[++index], value);
    else if (value === "--real-zip") parsed.realZip = requiredArg(args[++index], value);
    else if (value === "--modes") parsed.modes = requiredArg(args[++index], value).split(",").filter(Boolean);
    else throw new Error(`Unknown benchmark option: ${value}`);
  }
  return parsed;
}

function positiveInteger(value, option) {
  const number = Number(requiredArg(value, option));
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${option} must be a positive integer`);
  return number;
}

function requiredArg(value, option) {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function format(value, width) {
  return value.toFixed(1).padStart(width);
}

function formatInteger(value, width) {
  return (value === undefined ? "-" : value.toLocaleString("en-US")).padStart(width);
}
