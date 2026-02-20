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

import { ZPMClient } from "./client";
import { WorkerMode } from "./types";

const [,, cmd, ...rest] = process.argv;

const client = new ZPMClient();

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key   = arg.slice(2);
      const next  = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out["_"] = arg; // positional
    }
  }
  return out;
}

function printStats(stats: Awaited<ReturnType<ZPMClient["stats"]>>): void {
  for (const s of stats) {
    const uptime = s.uptime != null
      ? `${Math.round(s.uptime / 1000)}s`
      : "–";
    const mem = s.memoryRss != null
      ? `${Math.round(s.memoryRss / 1024 / 1024)} MB`
      : "–";
    const cpu = s.cpu != null ? `${s.cpu.toFixed(1)}%` : "–";

    console.log(
      `  [${s.status.toUpperCase().padEnd(8)}] ${s.name.padEnd(20)}` +
      `PID: ${String(s.pid ?? "–").padEnd(7)}` +
      `UP: ${uptime.padEnd(8)}  ` +
      `CPU: ${cpu.padEnd(7)}  MEM: ${mem}  ` +
      `Restarts: ${s.restartCount}`
    );
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      const flags = parseFlags(rest);
      const script = flags["_"] as string | undefined;
      if (!script) { console.error("Usage: zpm start <script> [--name <n>]"); process.exit(1); }

      await client.ensureDaemon();
      const msg = await client.start({
        name:       (flags["name"] as string) ?? script,
        scriptPath: script,
        port:       flags["port"] ? Number(flags["port"]) : undefined,
        instances:  flags["instances"] ? Number(flags["instances"]) : 1,
        devMode:    Boolean(flags["dev"]),
        mode:       flags["cluster"] ? WorkerMode.Cluster : WorkerMode.Fork,
      });
      console.log("[ZPM]", msg);
      break;
    }

    case "stop": {
      const [name] = rest;
      if (!name) { console.error("Usage: zpm stop <name>"); process.exit(1); }
      const msg = await client.stop(name);
      console.log("[ZPM]", msg);
      break;
    }

    case "restart": {
      const [name] = rest;
      if (!name) { console.error("Usage: zpm restart <name>"); process.exit(1); }
      const msg = await client.restart(name);
      console.log("[ZPM]", msg);
      break;
    }

    case "delete": {
      const [name] = rest;
      if (!name) { console.error("Usage: zpm delete <name>"); process.exit(1); }
      const msg = await client.delete(name);
      console.log("[ZPM]", msg);
      break;
    }

    case "list": {
      const names = await client.list();
      if (names.length === 0) { console.log("[ZPM] No workers registered."); break; }
      names.forEach((n) => console.log(" •", n));
      break;
    }

    case "stats": {
      const [name] = rest;
      const stats = await client.stats(name);
      if (stats.length === 0) { console.log("[ZPM] No stats available."); break; }
      printStats(stats);
      break;
    }

    case "kill-daemon": {
      await client.killDaemon();
      break;
    }

    default:
      console.log(`
  @zuzjs/pm – Process Manager

  Commands:
    zpm start  <script>  [--name <n>] [--port <p>] [--instances <i>] [--dev] [--cluster]
    zpm stop   <name>
    zpm restart <name>
    zpm delete  <name>
    zpm list
    zpm stats  [name]
    zpm kill-daemon
      `);
  }
}

main().catch((err) => {
  console.error("[ZPM] Error:", err.message ?? err);
  process.exit(1);
});
