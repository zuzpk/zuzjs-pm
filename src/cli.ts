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
import net from "node:net";
import path from "node:path";
import pc from "picocolors";
import pkgJson from "../package.json";
import { ZPMClient } from "./client";
import { getSocketPath } from "./ipc-server";
import { WorkerMode } from "./types";

const program = new Command();

program
.option("-s, --namespace <name>", "Internal daemon namespace", "zuzjs-pm");

program.parseOptions(process.argv);

const options = program.opts();
const namespace = options.namespace;

const client = new ZPMClient(namespace);


program
  .name("zpm")
  .description("Production grade process manager for the @zuzjs ecosystem")
  .version(pkgJson.version, '-v, --version', 'output the current version');


// START
program
  .command("start <script>")
  .description("Start a new process")
  .option("-n, --name <name>", "Unique name for the process")
  .option("-p, --port <port>", "Port the app listens on", parseInt)
  .option("-i, --instances <number>", "Number of instances (cluster mode)", parseInt, 1)
  .option("-d, --dev", "Enable development mode (auto-restart)", false)
  .option("-c, --cluster", "Use cluster mode instead of fork", false)
  .action(async (script, options) => {
    try {
      await client.ensureDaemon();
      const scriptPath = path.resolve(process.cwd(), script);
      
      const msg = await client.start({
        name: options.name ?? path.basename(script),
        scriptPath,
        port: options.port,
        instances: options.instances,
        devMode: options.dev,
        mode: options.cluster ? WorkerMode.Cluster : WorkerMode.Fork,
      });
      console.log(pc.cyan(`[ZPM]`), msg)
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

program.parse(process.argv);