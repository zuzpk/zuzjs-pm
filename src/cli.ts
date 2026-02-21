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
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ZPMClient } from "./client";
import { getSocketPath } from "./ipc-server";
import { WorkerMode } from "./types";

const program = new Command();

program
.option("-s, --namespace <name>", "Internal daemon namespace", "zuz-pm");

program.parseOptions(process.argv);

const options = program.opts();
const namespace = options.namespace;

const client = new ZPMClient(namespace);

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.resolve(__dirname, `../package.json`)
const pkg = JSON.parse(fs.readFileSync(pkgPath, `utf8`))

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
  .command("start <script>")
  .description("Start a new process")
  .option("-n, --name <name>", "Unique name for the process")
  .option("-p, --port <port>", "Port the app listens on", parseInt)
  .option("-i, --instances <number>", "Number of instances (cluster mode)", parseInt, 1)
  
  .option("-d, --dev", "Enable development mode (auto-restart)", false)
  .option("--reload-cmd <command>", "Command to run before restarting in dev mode")

  .option("-c, --cluster", "Use cluster mode instead of fork", false)
  .option("--ws <url>", "WebSocket URL to stream logs (e.g. for ZPanel)", "http://127.0.0.1:2082/_/wss/zpm")
  .option("--save-logs", "Save logs to a local file", false)
  .option("--args <string>", "Arguments to pass to the script (e.g. \"dev -p 3000\")")
  .option("--probe-type <type>", "Type of probe: http, tcp, or exec")
  .option("--probe-target <target>", "URL, host:port, or command")
  .option("--probe-interval <sec>", "Seconds between probes", parseInt, 30)
  .option("--probe-threshold <count>", "Failures before restart", parseInt, 3)
  .action(async (script, options) => {
    try {
      await client.ensureDaemon();
      const scriptPath = path.resolve(process.cwd(), script);
      const processName = options.name ?? path.basename(script);

      const msg = await client.start({
        name: options.name ?? path.basename(script),
        scriptPath,
        port: options.port,
        instances: options.instances,
        devMode: options.dev,
        mode: options.cluster ? WorkerMode.Cluster : WorkerMode.Fork,
        args: options.args ? options.args.split(" ") : [],
        reloadCommand: options.reloadCmd,
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

      if (options.dev) {
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
  .action(async () => {
    const names = await client.list();
    if (names.length === 0) {
      console.log("No workers registered.");
      return;
    }
    console.log("\x1b[1mManaged Processes:\x1b[0m");
    names.forEach(n => console.log(` • ${n}`));
  });

// STATS
program
  .command("stats [name]")
  .description("Show telemetry for processes")
  .action(async (name) => {
    const stats = await client.stats(name);
    if (stats.length === 0) {
      console.log("No stats available.");
      return;
    }
    
    stats.forEach(s => {
      const uptime = s.uptime ? `${Math.round(s.uptime / 1000)}s` : "0s";
      const statusColor = s.status === "running" ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `${statusColor}[${s.status.toUpperCase()}]\x1b[0m ` +
        `\x1b[1m${s.name.padEnd(15)}\x1b[0m ` +
        `PID: ${String(s.pid ?? "N/A").padEnd(6)} ` +
        `CPU: ${String(s.cpu ?? 0).padStart(3)}% ` +
        `MEM: ${Math.round((s.memoryRss ?? 0) / 1024 / 1024)}MB ` +
        `Uptime: ${uptime}`
      );
    });
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

// KILL DAEMON
program
  .command("kill-daemon")
  .description("Stop the background ZPM daemon")
  .action(async () => {
    await client.killDaemon();
    console.log("\x1b[33mDaemon killed.\x1b[0m");
  });


program
  .command("store")
  .description("Show raw internal store state for debugging")
  .action(async () => {
    const response = await client.getStore();
    if ( response.ok ){
      const data : any[] = response.data as any[]
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

program.parse(process.argv);