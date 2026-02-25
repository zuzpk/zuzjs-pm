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

// Boot
async function main(): Promise<void> {

  logger.success("daemon", `Booting ZPM daemon (PID ${process.pid})`);
  writePid();

  const pm      = new ProcessManager();
  const server  = startIPCServer(pm);

  if (fs.existsSync(pm.SNAPSHOT_FILE)) {
    try {
      const raw = fs.readFileSync(pm.SNAPSHOT_FILE, "utf-8");
      const savedConfigs = JSON.parse(raw);

      if (Array.isArray(savedConfigs) && savedConfigs.length > 0) {

        logger.info("daemon", `Restoring ${savedConfigs.length} workers from snapshot...`);
        
        for (const config of savedConfigs) {
          // Check if it's already running (unlikely on fresh boot but safe)
          // We use start() because it handles spawning and status updates
          pm.start(config).catch(err => {
            logger.error("daemon", `Failed to restore worker "${config.name}":`, err.message);
          });
        }
      }
    } catch (err: any) {
      logger.error("daemon", "Snapshot restoration failed:", err.message);
    }
  }

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info("daemon", `Received ${signal} – shutting down…`);
    pm.saveSnapshot();
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
