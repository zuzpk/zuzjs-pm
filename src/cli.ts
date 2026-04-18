#!/usr/bin/env node
/**
 * cli.ts
 * @zuzjs/pm CLI  –  `zpm <command> [options]`
 *
 * Commands:
 *   zpm start  <script> [--name <n>] [--port <p>] [--instances <i>] [--dev] [--cluster]
 *   zpm stop   <name>
 *   zpm restart <name>
 *   zpm delete  <name>
 *   zpm list
 *   zpm stats  [name]
 *   zpm logs   <name>          (future)
 *   zpm kill-daemon
 */

import { Command } from "commander";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ZPMClient } from "./client";
import { getSocketPath } from "./ipc-server";
import { WorkerMode } from "./types";

const program = new Command();

program
.option("-s, --namespace <name>", "Internal daemon namespace", process.env.ZPM_NAMESPACE ?? "zuz-pm");

program.parseOptions(process.argv);

const options = program.opts();
const namespace = options.namespace;

const client = new ZPMClient({ namespace });

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.resolve(__dirname, `../package.json`)
const pkg = JSON.parse(fs.readFileSync(pkgPath, `utf8`))

function parseArgString(input?: string): string[] {
  if (!input?.trim()) return [];

  const tokens: string[] = [];
  const rx = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;

  while ((m = rx.exec(input)) !== null) {
    tokens.push((m[1] ?? m[2] ?? m[3]).replace(/\\(["'\\])/g, "$1"));
  }

  return tokens;
}

function getPassthroughArgs(argv: string[]): string[] {
  const idx = argv.indexOf("--");
  return idx === -1 ? [] : argv.slice(idx + 1);
}

function readJsonFile<T = any>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function pingNamespace(namespace: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(getSocketPath(namespace));
    let buf = "";
    let done = false;

    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(value);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify({ cmd: "ping" }) + "\n");
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line);
          finish(res?.ok === true && res?.data === "pong");
          return;
        } catch {
          // ignore parse fragments
        }
      }
    });

    socket.on("error", () => finish(false));
    socket.setTimeout(1200, () => finish(false));
  });
}

function runCmd(command: string, cwd?: string): string | null {
  try {
    return execSync(command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }).toString().trim();
  } catch {
    return null;
  }
}

function runJsonCmd<T = any>(command: string, cwd?: string): T | null {
  const output = runCmd(command, cwd);
  if (!output) return null;

  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function hashFileSha256(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function runDaemonProvisioning(options?: {
  skipServiceRestart?: boolean;
  quiet?: boolean;
}): void {
  const skipServiceRestart = options?.skipServiceRestart ?? true;
  const quiet = options?.quiet ?? true;

  if (process.platform !== "linux") {
    if (!quiet) console.log(pc.yellow("[ZPM] setup-service is only available on Linux."));
    return;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid !== 0) {
    if (!quiet) console.log(pc.yellow("[ZPM] setup-service requires root (run with sudo)."));
    return;
  }

  const candidates = [
    path.resolve(__dirname, "postinstall.cjs"),
    path.resolve(__dirname, "postinstall.js"),
  ];

  const scriptPath = candidates.find((p) => fs.existsSync(p));
  if (!scriptPath) {
    if (!quiet) console.log(pc.red("[ZPM] postinstall script not found in dist."));
    return;
  }

  try {
    execSync(`${process.execPath} "${scriptPath}"`, {
      stdio: quiet ? "ignore" : "inherit",
      env: {
        ...process.env,
        ZPM_POSTINSTALL_NO_SERVICE_RESTART: skipServiceRestart ? "1" : "0",
      },
    });
    if (quiet) {
      console.log(pc.cyan(`[ZPM]`), pc.gray("Service unit check completed."));
    }
  } catch {
    if (!quiet) {
      console.log(pc.red("[ZPM] setup-service failed. Check output above."));
    }
  }
}

function formatUptime(ms: number | null): string {
  if (!ms || ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function formatCpu(cpu: number | null): string {
  if (cpu == null || Number.isNaN(cpu)) return "0.0%";
  return `${cpu.toFixed(1)}%`;
}

function formatMem(memoryRss: number | null): string {
  if (!memoryRss || Number.isNaN(memoryRss)) return "0 MB";
  return `${Math.round(memoryRss / 1024 / 1024)} MB`;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-9;]*m/g, "");
}

function truncateCell(input: string, max = 42): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    let width = stripAnsi(h).length;
    for (const row of rows) {
      width = Math.max(width, stripAnsi(row[i] ?? "").length);
    }
    return width;
  });

  const makeLine = (cells: string[]) =>
    `| ${cells.map((c, i) => {
      const pad = widths[i] - stripAnsi(c).length;
      return `${c}${" ".repeat(Math.max(0, pad))}`;
    }).join(" | ")} |`;

  const sep = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;

  const out: string[] = [];
  out.push(sep);
  out.push(makeLine(headers));
  out.push(sep);
  for (const row of rows) out.push(makeLine(row));
  out.push(sep);
  return out.join("\n");
}

function statusLabel(status: string): string {
  if (status === "running") return pc.green(status.toUpperCase());
  if (status === "stopped") return pc.yellow(status.toUpperCase());
  if (status === "starting" || status === "stopping") return pc.cyan(status.toUpperCase());
  return pc.red(status.toUpperCase());
}

type TableMode = "normal" | "compact" | "wide";
type SortOrder = "asc" | "desc";

const validStatuses = new Set(["stopped", "starting", "running", "stopping", "crashed", "errored"]);
const validSortFields = new Set([
  "name",
  "status",
  "pid",
  "cpu",
  "mem",
  "uptime",
  "restarts",
  "mode",
  "cwd",
  "script",
]);

function getSortOrder(field: string, requestedOrder?: string): SortOrder {
  if (requestedOrder === "asc" || requestedOrder === "desc") return requestedOrder;
  // Resource/uptime style sorts default to descending for convenience.
  if (["cpu", "mem", "uptime", "restarts"].includes(field)) return "desc";
  return "asc";
}

function sortValue(stat: any, field: string): string | number {
  switch (field) {
    case "cpu":
      return stat.cpu ?? 0;
    case "mem":
      return stat.memoryRss ?? 0;
    case "uptime":
      return stat.uptime ?? 0;
    case "restarts":
      return stat.restartCount ?? 0;
    case "pid":
      return stat.pid ?? -1;
    case "status":
      return String(stat.status ?? "").toLowerCase();
    case "mode":
      return String(stat.mode ?? "").toLowerCase();
    case "cwd":
      return String(stat.cwd ?? "").toLowerCase();
    case "script":
      return String(stat.scriptPath ?? "").toLowerCase();
    case "name":
    default:
      return String(stat.name ?? "").toLowerCase();
  }
}

function applyWorkerQuery(stats: any[], options: any): any[] {
  let out = [...stats];

  if (options.status) {
    const status = String(options.status).toLowerCase();
    if (!validStatuses.has(status)) {
      throw new Error(
        `Invalid --status value "${options.status}". Use one of: ${[...validStatuses].join(", ")}`
      );
    }
    out = out.filter((s) => String(s.status ?? "").toLowerCase() === status);
  }

  if (options.sort) {
    const field = String(options.sort).toLowerCase();
    if (!validSortFields.has(field)) {
      throw new Error(
        `Invalid --sort value "${options.sort}". Use one of: ${[...validSortFields].join(", ")}`
      );
    }

    const order = getSortOrder(field, options.order ? String(options.order).toLowerCase() : undefined);

    out.sort((a, b) => {
      const av = sortValue(a, field);
      const bv = sortValue(b, field);
      const cmp = av > bv ? 1 : av < bv ? -1 : 0;
      return order === "desc" ? -cmp : cmp;
    });
  }

  return out;
}

function resolveTableMode(options: any): TableMode {
  if (options.wide) return "wide";
  if (options.compact) return "compact";
  return "normal";
}

function printWorkerTable(stats: any[], mode: TableMode = "normal"): void {
  const baseRows = stats.map((s, idx) => ({
    id: String(idx),
    name: truncateCell(String(s.name ?? ""), 24),
    mode: String(s.mode ?? "fork"),
    pid: String(s.pid ?? "N/A"),
    status: statusLabel(String(s.status ?? "unknown")),
    restarts: String(s.restartCount ?? 0),
    uptime: formatUptime(s.uptime ?? null),
    cpu: formatCpu(s.cpu ?? null),
    mem: formatMem(s.memoryRss ?? null),
    cwd: truncateCell(String(s.cwd ?? "-"), 30),
    script: truncateCell(String(s.scriptPath ?? "-"), 32),
    last: truncateCell(String(s.lastError ?? s.lastLog ?? "-"), 46),
  }));

  if (mode === "compact") {
    const headers = ["id", "name", "pid", "status", "uptime", "cpu", "mem", "restarts"];
    const rows = baseRows.map((r) => [r.id, r.name, r.pid, r.status, r.uptime, r.cpu, r.mem, r.restarts]);
    console.log(renderTable(headers, rows));
    return;
  }

  if (mode === "wide") {
    const headers = [
      "id",
      "name",
      "mode",
      "pid",
      "status",
      "restarts",
      "uptime",
      "cpu",
      "mem",
      "cwd",
      "script",
      "last error/log",
    ];
    const rows = stats.map((s, idx) => [
      String(idx),
      truncateCell(String(s.name ?? ""), 24),
      String(s.mode ?? "fork"),
      String(s.pid ?? "N/A"),
      statusLabel(String(s.status ?? "unknown")),
      String(s.restartCount ?? 0),
      formatUptime(s.uptime ?? null),
      formatCpu(s.cpu ?? null),
      formatMem(s.memoryRss ?? null),
      truncateCell(String(s.cwd ?? "-"), 64),
      truncateCell(String(s.scriptPath ?? "-"), 72),
      truncateCell(String(s.lastError ?? s.lastLog ?? "-"), 88),
    ]);
    console.log(renderTable(headers, rows));
    return;
  }

  const headers = [
    "id",
    "name",
    "mode",
    "pid",
    "status",
    "restarts",
    "uptime",
    "cpu",
    "mem",
    "cwd",
    "script",
    "last error",
  ];

  const rows = baseRows.map((r) => [
    r.id,
    r.name,
    r.mode,
    r.pid,
    r.status,
    r.restarts,
    r.uptime,
    r.cpu,
    r.mem,
    r.cwd,
    r.script,
    r.last,
  ]);

  console.log(renderTable(headers, rows));
}

function detectProjectStart(cwd: string, cargoBin?: string): {
  scriptPath: string;
  args: string[];
  suggestedName: string;
  detected: string;
  detectedPort?: number;
} | null {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJson = readJsonFile<any>(packageJsonPath);

  if (packageJson?.scripts?.start) {
    const startScript: string = String(packageJson.scripts.start);
    const portMatch = startScript.match(/(?:^|\s)(?:--port|-p)\s+(\d+)(?:\s|$)/);
    const detectedPort = portMatch ? Number(portMatch[1]) : undefined;

    const packageManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(cwd, "yarn.lock"))
        ? "yarn"
        : fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))
          ? "bun"
          : "npm";

    const args = packageManager === "yarn"
      ? ["start"]
      : ["run", "start"];

    return {
      scriptPath: packageManager,
      args,
      suggestedName: packageJson.name ?? path.basename(cwd),
      detected: packageJson.dependencies?.next || packageJson.devDependencies?.next ? "nextjs" : "node",
      detectedPort,
    };
  }

  const pyCandidates = ["main.py", "app.py", "manage.py", "server.py"];
  for (const file of pyCandidates) {
    const full = path.join(cwd, file);
    if (fs.existsSync(full)) {
      return {
        scriptPath: full,
        args: [],
        suggestedName: path.basename(cwd),
        detected: "python",
      };
    }
  }

  const cargoTomlPath = path.join(cwd, "Cargo.toml");
  if (fs.existsSync(cargoTomlPath)) {
    try {
      const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
      const packageNameMatch = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
      const packageName = cargoBin ?? packageNameMatch?.[1];

      if (packageName) {
        const releaseBin = path.join(cwd, "target", "release", packageName);
        const debugBin = path.join(cwd, "target", "debug", packageName);

        if (fs.existsSync(releaseBin)) {
          return {
            scriptPath: releaseBin,
            args: [],
            suggestedName: packageName,
            detected: "rust-binary",
          };
        }

        if (fs.existsSync(debugBin)) {
          return {
            scriptPath: debugBin,
            args: [],
            suggestedName: packageName,
            detected: "rust-binary",
          };
        }
      }
    } catch {
      // ignore parse errors and continue
    }

    return {
      scriptPath: "cargo",
      args: cargoBin ? ["run", "--release", "--bin", cargoBin] : ["run", "--release"],
      suggestedName: cargoBin ?? path.basename(cwd),
      detected: "rust-cargo",
    };
  }

  return null;
}

async function attachLogStream(namespace: string, name: string | undefined) {
  const isRunning = await client.isDaemonRunning();
  if (!isRunning) return;

  const label = name ? `"${name}"` : "all workers";
  console.log(pc.cyan(`[ZPM]`), pc.gray(`Attaching stream for ${label}...`));

  const socket = net.createConnection(getSocketPath(namespace));
  socket.write(JSON.stringify({ cmd: "logs", name }) + "\n");

  socket.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const res = JSON.parse(line);
        if (res.ok) {
          process.stdout.write(res.data);
        }
      } catch (e) { /* ignore partials */ }
    }
  });

  socket.on("error", (err) => {
    console.error(pc.red(`[IPC Error] ${err.message}`));
  });

  process.on("SIGINT", () => {
    socket.destroy();
    console.log(pc.gray("\nDisconnected from logs."));
    process.exit();
  });
}

program
  .name("zpm")
  .description("Production grade process manager for the @zuzjs ecosystem")
  .version(pkg.version, '-v, --version', 'output the current version');


// START
program
  .command("start [script]")
  .description("Start a new process")
  .option("-n, --name <name>", "Unique name for the process")
  .option("--cwd <dir>", "Working directory for the process (can be relative, e.g. ..)")
  .option("-p, --port <port>", "Port the app listens on", parseInt)
  .option("-i, --instances <number>", "Number of instances (cluster mode)", parseInt, 1)
  
  .option("-d, --dev", "Enable development mode (auto-restart)", false)
  .option("--watch", "Alias for --dev", false)
  .option("--reload-cmd <command>", "Command to run before restarting in dev mode")
  .option("-u, --user <username>", "User to run the process as")
  .option("-c, --cluster", "Use cluster mode instead of fork", false)
  .option("--ws <url>", "WebSocket URL to stream logs (e.g. for ZPanel)", "http://127.0.0.1:2082/_/wss/zpm")
  .option("--save-logs", "Save logs to a local file", false)
  .option("--arg <string>", "Arguments to pass to the executable (e.g. \"run start -p 3000\")")
  .option("--args <string>", "Alias for --arg")
  .option("--cargo-bin <name>", "Rust binary name to run when project is Cargo workspace/package")
  .option("--interpreter <type>", "Force runtime: auto|node|python3|bash|custom", "auto")
  .option("--with <type>", "Alias for --interpreter")
  .option("--interpreter-command <command>", "Executable used when --interpreter=custom")
  .option("--probe-type <type>", "Type of probe: http, tcp, or exec")
  .option("--probe-target <target>", "URL, host:port, or command")
  .option("--probe-interval <sec>", "Seconds between probes", parseInt, 30)
  .option("--probe-threshold <count>", "Failures before restart", parseInt, 3)
  .allowExcessArguments(true)
  .action(async (script, options) => {
    try {
      await client.ensureDaemon();

      const resolvedCwd = options.cwd
        ? path.resolve(process.cwd(), options.cwd)
        : process.cwd();

      if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
        throw new Error(`Invalid cwd: ${resolvedCwd}`);
      }

      const passthroughArgs = getPassthroughArgs(process.argv);
      const parsedArgOption = parseArgString(options.arg ?? options.args);

      const hasConfigOverride =
        Boolean(options.name) ||
        Boolean(options.cwd) ||
        Boolean(options.arg) ||
        Boolean(options.args) ||
        passthroughArgs.length > 0 ||
        Boolean(options.port) ||
        Boolean(options.cluster) ||
        Boolean(options.dev) ||
        Boolean(options.watch) ||
        Boolean(options.cargoBin) ||
        Boolean(options.interpreterCommand) ||
        Boolean(options.reloadCmd) ||
        Boolean(options.user) ||
        Boolean(options.probeType) ||
        Boolean(options.probeTarget) ||
        options.instances !== 1 ||
        (options.with ?? options.interpreter) !== "auto";

      // Shortcut: allow `zpm start <existing-worker-name>` to resume a stopped/crashed worker
      // without re-specifying script/cwd args.
      if (script && !hasConfigOverride) {
        const existing = await client.getWorkerByName(script);
        if (existing) {
          const msg = await client.startWorker(script);
          console.log(pc.cyan(`[ZPM]`), msg);
          process.exit(0);
        }
      }

      // Commander may bind the first token after `--` to optional [script].
      // If that happens, treat it as passthrough arg instead of executable.
      const effectiveScript =
        script && passthroughArgs.length > 0 && script === passthroughArgs[0]
          ? undefined
          : script;

      let detected = detectProjectStart(resolvedCwd, options.cargoBin);

      if (!effectiveScript && !detected) {
        throw new Error(
          "No script was provided and project type could not be auto-detected. " +
          "Pass a script/command explicitly, e.g. `zpm start app.js` or `zpm start pnpm --arg=\"run start\"`."
        );
      }

      const selectedScript = effectiveScript ?? detected!.scriptPath;

      const isPathLike =
        path.isAbsolute(selectedScript) ||
        selectedScript.startsWith(".") ||
        selectedScript.includes("/") ||
        selectedScript.includes("\\");

      const localCandidate = path.resolve(resolvedCwd, selectedScript);
      const shouldUseLocalPath = !isPathLike && fs.existsSync(localCandidate);

      // Keep bare commands (e.g. "next", "tsx", "python") untouched so
      // they can be resolved from PATH/node_modules/.bin at runtime.
      const scriptPath = isPathLike
        ? path.resolve(resolvedCwd, selectedScript)
        : shouldUseLocalPath
          ? localCandidate
          : selectedScript;

      const autoDetectedArgs = effectiveScript ? [] : (detected?.args ?? []);

      const mergedArgs = [
        ...autoDetectedArgs,
        ...parsedArgOption,
        ...passthroughArgs,
      ];

      // In rust-binary auto-detect mode, users often pass cargo-style args like
      // `--arg="-- /path/to/config"`. Unlike `cargo run`, direct binary execution
      // should not receive the separator token itself.
      const normalizedArgs =
        detected?.detected === "rust-binary" && mergedArgs[0] === "--"
          ? mergedArgs.slice(1)
          : mergedArgs;

      const processName = options.name
        ?? detected?.suggestedName
        ?? path.basename(selectedScript);

      if (!effectiveScript && detected) {
        console.log(pc.cyan(`[ZPM]`), pc.gray(`Auto-detected ${detected.detected} project in ${resolvedCwd}`));
      }

      const msg = await client.start({
        name: processName,
        scriptPath,
        cwd: resolvedCwd,
        port: options.port ?? detected?.detectedPort,
        instances: options.instances,
        devMode: options.dev || options.watch,
        interpreter: options.with ?? options.interpreter,
        interpreterCommand: options.interpreterCommand,
        mode: options.cluster ? WorkerMode.Cluster : WorkerMode.Fork,
        args: normalizedArgs,
        reloadCommand: options.reloadCmd,
        user: options.user,
        probe: options.probeTarget ? {
          type: options.probeType,
          target: options.probeTarget || (options.probeType === 'http' ? 'http://localhost:3000' : 'localhost:3000'),
          intervalSeconds: options.probeInterval,
          failureThreshold: options.probeThreshold,
          timeoutSeconds: 5
        } : undefined,
        logs: {
          wsUrl: options.ws,
          saveToFile: options.saveLogs
        }
      });
      
      console.log(pc.cyan(`[ZPM]`), msg)

      if (options.dev || options.watch) {
        await attachLogStream(namespace, processName);
      } else {
        process.exit(0); // Exit if not in dev mode to return terminal control
      }

    } catch (err: any) {
      console.log(pc.cyan(`[ZPM]`), pc.red(`[ERROR]`), err.message)
    }
  });

// LOGS (The Tail implementation) ---
program
  .command("logs [name]")
  .description("Stream real-time logs (omit name for all logs)")
  .action(async (name) => {
    try {
      const isRunning = await client.isDaemonRunning();
      if (!isRunning) throw new Error("Daemon is not running.");

      const label = name ? `"${name}"` : "all workers";

      console.log(pc.cyan(`[ZPM]`), `Streaming logs for "${pc.green(label)}" (Ctrl+C to stop)`);

      const socket = net.createConnection(getSocketPath(namespace));
      
      // Send the specialized log command
      socket.write(JSON.stringify({ cmd: "logs", name }) + "\n");

      socket.on("data", (chunk) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const res = JSON.parse(line);
            if (res.ok) {
              // Print the raw data received from worker's stdout/stderr
              process.stdout.write(res.data);
            } else {
              console.error(`\x1b[31m${res.error}\x1b[0m`);
              process.exit(1);
            }
          } catch (e) {
            // Handle partial JSON or binary data gracefully
          }
        }
      });

      socket.on("error", (err) => {
        console.error(`\x1b[31m[IPC Error]\x1b[0m ${err.message}`);
        process.exit(1);
      });

      // Keep process alive until Ctrl+C
      process.on("SIGINT", () => {
        socket.destroy();
        console.log("\n\x1b[90mDisconnected from logs.\x1b[0m");
        process.exit();
      });
      
    } catch (err: any) {
      console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
    }
  });

// LIST
program
  .command("list")
  .description("List all managed processes")
  .option("--json", "Emit machine-readable JSON")
  .option("--compact", "Compact table view")
  .option("--wide", "Wide table view with larger path/error columns")
  .option("--status <status>", "Filter by status: running|stopped|starting|stopping|crashed|errored")
  .option("--sort <field>", "Sort by: name|status|pid|cpu|mem|uptime|restarts|mode|cwd|script")
  .option("--order <order>", "Sort order: asc|desc")
  .action(async (options) => {
    const stats = applyWorkerQuery(await client.stats(), options);
    if (stats.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log("No workers match the current query.");
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    printWorkerTable(stats, resolveTableMode(options));
  });

// STATS
program
  .command("stats [name]")
  .description("Show telemetry for processes")
  .option("--json", "Emit machine-readable JSON")
  .option("--compact", "Compact table view")
  .option("--wide", "Wide table view with larger path/error columns")
  .option("--status <status>", "Filter by status: running|stopped|starting|stopping|crashed|errored")
  .option("--sort <field>", "Sort by: name|status|pid|cpu|mem|uptime|restarts|mode|cwd|script")
  .option("--order <order>", "Sort order: asc|desc")
  .action(async (name, options) => {
    const stats = applyWorkerQuery(await client.stats(name), options);

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    if (stats.length === 0) {
      console.log("No workers match the current query.");
      return;
    }

    printWorkerTable(stats, resolveTableMode(options));
  });

// STOP / RESTART / DELETE
["stop", "restart", "delete"].forEach((action) => {
  program
    .command(`${action} <name>`)
    .description(`${action.charAt(0).toUpperCase() + action.slice(1)} a process`)
    .action(async (name) => {
      try {
        const msg = await (client as any)[action](name);
        console.log(`\x1b[32m[ZPM]\x1b[0m ${msg}`);
      } catch (err: any) {
        console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
      }
    });
});

// START DAEMON
program
  .command("start-daemon")
  .description("Start the background ZPM daemon")
  .action(async () => {
    await client.ensureDaemon();
    runDaemonProvisioning({ skipServiceRestart: true, quiet: true });
    console.log("\x1b[32m[ZPM]\x1b[0m Daemon started.");
  });

// START DAEMON
program
  .command("restart-daemon")
  .description("Restart the background ZPM daemon")
  .action(async () => {
    try {
      await client.restartDaemon();
      runDaemonProvisioning({ skipServiceRestart: true, quiet: true });
      console.log("\x1b[32m[ZPM]\x1b[0m Daemon restarted.");
    } catch (err: any) {
      console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
    }
  });

// SERVICE SETUP
program
  .command("setup-service")
  .description("Provision or refresh Linux systemd unit for zpm daemon")
  .option("--restart-service", "Restart zpm.service after provisioning", false)
  .action(async (options) => {
    runDaemonProvisioning({
      skipServiceRestart: !options.restartService,
      quiet: false,
    });
  });

// KILL DAEMON
program
  .command("kill-daemon")
  .description("Stop the background ZPM daemon")
  .action(async () => {
    try {
      await client.killDaemon();
      console.log("\x1b[33mDaemon killed.\x1b[0m");
    } catch (err: any) {
      console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
    }
  });


program
  .command("store")
  .description("Show raw internal store state for debugging")
  .action(async () => {
    const response = await client.getStore();
    if ( response ){
      const data : any[] = response as any[]
      if (data.length === 0) {
        console.log(pc.yellow("Store is empty."));
        return;
      }

      console.log(pc.magenta("\n--- Internal Process Store ---"));
      console.table(data);
      console.log(pc.gray(`Total Managed Processes: ${data.length}\n`));
    }
    else{
      console.log(`StoreError`, response);
    }
  });

program
  .command("doctor")
  .description("Deep diagnostics: daemon health, namespace wiring, and npm hash checks")
  .option("--json", "Output machine-readable JSON diagnostics", false)
  .action(async (options) => {
    const packageRoot = path.dirname(pkgPath);
    const hasSourceTree = fs.existsSync(path.join(packageRoot, "src"));
    const gitTopLevel = runCmd("git rev-parse --show-toplevel", packageRoot);
    const isGitRepo = !!gitTopLevel;
    const canCheckPublishParity = hasSourceTree && isGitRepo;

    const localCliPath = path.join(packageRoot, "dist", "cli.cjs");
    const localCliHash = hashFileSha256(localCliPath);
    const socketPath = getSocketPath(namespace);
    const pidFilePath = path.join(os.tmpdir(), `${namespace}.pid`);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const socketOwnerUid = (() => {
      try {
        if (!fs.existsSync(socketPath)) return null;
        return fs.statSync(socketPath).uid;
      } catch {
        return null;
      }
    })();
    const mayRequireSudo =
      currentUid !== null &&
      currentUid !== 0 &&
      socketOwnerUid !== null &&
      socketOwnerUid !== currentUid;

    const daemonReachable = await pingNamespace(namespace);
    const socketExists = fs.existsSync(socketPath);
    const pidFileExists = fs.existsSync(pidFilePath);
    const pidRaw = pidFileExists ? fs.readFileSync(pidFilePath, "utf8").trim() : null;
    const pid = pidRaw ? Number(pidRaw) : null;

    let pidAlive: boolean | null = null;
    if (pid && Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
    }

    const globalBinPath = runCmd("which zpm");
    const globalRoot = runCmd("npm root -g");
    const globalPkgPath = globalRoot ? path.join(globalRoot, "@zuzjs", "pm", "package.json") : null;
    const globalPkg = globalPkgPath ? readJsonFile<{ version?: string }>(globalPkgPath) : null;
    const globalCliHash = globalBinPath ? hashFileSha256(globalBinPath) : null;

    const npmLatestVersion = runJsonCmd<string>("npm view @zuzjs/pm version --json");
    const npmCurrentVersionShasum = runJsonCmd<string>(`npm view @zuzjs/pm@${pkg.version} dist.shasum --json`);
    const npmCurrentVersionIntegrity = runJsonCmd<string>(`npm view @zuzjs/pm@${pkg.version} dist.integrity --json`);

    let localPackInfo: Array<{ filename: string; shasum: string; integrity?: string }> | null = null;
    if (canCheckPublishParity) {
      localPackInfo = runJsonCmd<Array<{ filename: string; shasum: string; integrity?: string }>>(
        "npm pack --json --dry-run",
        packageRoot,
      );

      if (!localPackInfo) {
        localPackInfo = runJsonCmd<Array<{ filename: string; shasum: string; integrity?: string }>>(
          "npm pack --json",
          packageRoot,
        );

        const tarballName = localPackInfo?.[0]?.filename;
        if (tarballName) {
          const tarballPath = path.join(packageRoot, tarballName);
          if (fs.existsSync(tarballPath)) fs.unlinkSync(tarballPath);
        }
      }
    }

    const localPackedShasum = localPackInfo?.[0]?.shasum ?? null;
    const localPackedIntegrity = localPackInfo?.[0]?.integrity ?? null;

    const shasumMatchesRegistry =
      !!npmCurrentVersionShasum &&
      !!localPackedShasum &&
      npmCurrentVersionShasum === localPackedShasum;

    const integrityMatchesRegistry =
      !!npmCurrentVersionIntegrity &&
      !!localPackedIntegrity &&
      npmCurrentVersionIntegrity === localPackedIntegrity;

    const gitDirtyRaw = isGitRepo ? runCmd("git status --porcelain", gitTopLevel!) : null;
    const gitDirty = gitDirtyRaw ? gitDirtyRaw.length > 0 : null;

    const statusLabel = (ok: boolean | null) => {
      if (ok === null) return pc.yellow("UNKNOWN");
      return ok ? pc.green("OK") : pc.red("FAIL");
    };

    const cliHashMatch = !!localCliHash && !!globalCliHash ? localCliHash === globalCliHash : null;

    const diagnostics = {
      namespace,
      daemon: {
        socketPath,
        socketExists,
        socketOwnerUid,
        pidFilePath,
        pidFileExists,
        pid,
        pidAlive,
        reachable: daemonReachable,
      },
      install: {
        cliPackageVersion: pkg.version,
        globalBinPath,
        globalPackageVersion: globalPkg?.version ?? null,
        localCliSha256: localCliHash,
        globalCliSha256: globalCliHash,
        cliHashMatch,
      },
      registry: {
        npmLatestVersion,
        npmDistShasum: npmCurrentVersionShasum,
        localPackShasum: canCheckPublishParity ? localPackedShasum : null,
        shasumMatch: canCheckPublishParity ? (npmCurrentVersionShasum && localPackedShasum ? shasumMatchesRegistry : null) : null,
        npmIntegrity: npmCurrentVersionIntegrity,
        localPackIntegrity: canCheckPublishParity ? localPackedIntegrity : null,
        integrityMatch: canCheckPublishParity ? (npmCurrentVersionIntegrity && localPackedIntegrity ? integrityMatchesRegistry : null) : null,
        publishParityChecksSkipped: !canCheckPublishParity,
      },
      workspace: {
        isGitRepo,
        gitDirty,
      },
      hints: {
        stalePidDetected: !daemonReachable && pidFileExists && pidAlive === false,
        sudoLikelyRequired: mayRequireSudo,
        globalVersionDiffers: !!globalPkg?.version && globalPkg.version !== pkg.version,
        localNotLatest: !!npmLatestVersion && npmLatestVersion !== pkg.version,
        publishHashMismatch: canCheckPublishParity && !!npmCurrentVersionShasum && !!localPackedShasum && !shasumMatchesRegistry,
      },
    };

    if (options.json) {
      process.stdout.write(JSON.stringify(diagnostics, null, 2) + "\n");
      return;
    }

    console.log(pc.bold("\nZPM Doctor"));
    console.log(pc.gray("--------------------------------------------------"));
    console.log(`Namespace:           ${pc.cyan(namespace)}`);
    console.log(`Socket path:         ${socketPath} (${socketExists ? pc.green("exists") : pc.yellow("missing")})`);
    console.log(`Socket owner uid:    ${socketOwnerUid ?? "N/A"}`);
    console.log(`PID file:            ${pidFilePath} (${pidFileExists ? pc.green("exists") : pc.yellow("missing")})`);
    console.log(`PID value:           ${pid ?? "N/A"}`);
    console.log(`PID alive:           ${statusLabel(pidAlive)}`);
    console.log(`Daemon reachable:    ${statusLabel(daemonReachable)}`);

    console.log(pc.gray("\nInstall / Binary"));
    console.log(pc.gray("--------------------------------------------------"));
    console.log(`CLI package version: ${pkg.version}`);
    console.log(`Global zpm path:     ${globalBinPath ?? "N/A"}`);
    console.log(`Global pkg version:  ${globalPkg?.version ?? "N/A"}`);
    console.log(`Local cli sha256:    ${localCliHash ?? "N/A"}`);
    console.log(`Global cli sha256:   ${globalCliHash ?? "N/A"}`);
    console.log(`CLI hash match:      ${statusLabel(cliHashMatch)}`);

    console.log(pc.gray("\nRegistry / Publish"));
    console.log(pc.gray("--------------------------------------------------"));
    console.log(`npm latest version:  ${npmLatestVersion ?? "N/A"}`);
    console.log(`npm dist.shasum:     ${npmCurrentVersionShasum ?? "N/A"}`);
    console.log(`local pack shasum:   ${canCheckPublishParity ? (localPackedShasum ?? "N/A") : pc.yellow("SKIPPED (not source checkout)")}`);
    console.log(`shasum match:        ${canCheckPublishParity ? statusLabel(npmCurrentVersionShasum && localPackedShasum ? shasumMatchesRegistry : null) : pc.yellow("SKIPPED")}`);
    console.log(`npm integrity:       ${npmCurrentVersionIntegrity ?? "N/A"}`);
    console.log(`local integrity:     ${canCheckPublishParity ? (localPackedIntegrity ?? "N/A") : pc.yellow("SKIPPED (not source checkout)")}`);
    console.log(`integrity match:     ${canCheckPublishParity ? statusLabel(npmCurrentVersionIntegrity && localPackedIntegrity ? integrityMatchesRegistry : null) : pc.yellow("SKIPPED")}`);

    console.log(pc.gray("\nWorkspace"));
    console.log(pc.gray("--------------------------------------------------"));
    console.log(`git working tree:    ${isGitRepo ? (gitDirty === null ? pc.yellow("UNKNOWN") : gitDirty ? pc.yellow("DIRTY") : pc.green("CLEAN")) : pc.yellow("NOT A GIT CHECKOUT")}`);

    console.log(pc.gray("\nHints"));
    console.log(pc.gray("--------------------------------------------------"));
    if (!daemonReachable && pidFileExists && pidAlive === false) {
      console.log(pc.yellow("- Stale PID file detected. Run `zpm kill-daemon` to clean it."));
    }
    if (mayRequireSudo) {
      console.log(pc.yellow(`- Socket is owned by uid ${socketOwnerUid}. Daemon stop/restart may require sudo.`));
    }
    if (globalPkg?.version && globalPkg.version !== pkg.version) {
      console.log(pc.yellow(`- Global version (${globalPkg.version}) differs from current package (${pkg.version}).`));
    }
    if (npmLatestVersion && npmLatestVersion !== pkg.version) {
      console.log(pc.yellow(`- Local package version (${pkg.version}) is not npm latest (${npmLatestVersion}).`));
    }
    if (!canCheckPublishParity) {
      console.log(pc.yellow("- Publish parity checks are skipped outside a source checkout (git + src)."));
    }
    if (canCheckPublishParity && npmCurrentVersionShasum && localPackedShasum && !shasumMatchesRegistry) {
      console.log(pc.red("- Local packed artifact hash does not match npm dist.shasum for this version."));
      console.log(pc.red("  This usually means code changed without version bump/re-publish."));
    }
    console.log("");
  });

program.parse(process.argv);