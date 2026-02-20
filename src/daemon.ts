/**
 * daemon.ts
 * Entry point for the @zuzjs/pm background daemon.
 *
 * Usage (direct):
 *   node dist/daemon.js
 *
 * Usage (detached, via client):
 *   The client spawns this file with { detached: true, stdio: 'ignore' }
 *   so it survives the parent exiting.
 *
 * The daemon:
 *   1. Creates a ProcessManager instance.
 *   2. Starts an IPC Unix-socket server.
 *   3. Listens for OS signals for graceful shutdown.
 *   4. (Optional) Re-hydrates a persisted process list on startup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startIPCServer } from "./ipc-server";
import { logger } from "./logger";
import { ProcessManager } from "./process-manager";

// PID file

const PID_FILE = path.join(os.tmpdir(), "zuz-pm.pid");

function writePid(): void {
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function clearPid(): void {
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
}

// Snapshot persistence (optional)
// On graceful shutdown we write a JSON snapshot of running workers so they can
// be re-spawned automatically on the next daemon start.

const SNAPSHOT_FILE = path.join(os.tmpdir(), "zuz-pm.snapshot.json");

function saveSnapshot(pm: ProcessManager): void {
  try {
    const list = pm.list();
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(list, null, 2));
  } catch { /* non-critical */ }
}

// Boot

async function main(): Promise<void> {
  logger.success("daemon", `Booting ZPM daemon (PID ${process.pid})`);
  writePid();

  const pm     = new ProcessManager();
  const server = startIPCServer(pm);

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info("daemon", `Received ${signal} – shutting down…`);
    saveSnapshot(pm);
    server.close();
    await pm.stopAll();
    clearPid();
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep alive
  process.on("uncaughtException",  (err) => logger.error("daemon", "Uncaught exception:", err));
  process.on("unhandledRejection", (reason) => logger.error("daemon", "Unhandled rejection:", reason));

  logger.success("daemon", "Ready – waiting for IPC commands.");
}

main().catch((err) => {
  logger.error("daemon", "Fatal startup error:", err);
  process.exit(1);
});
