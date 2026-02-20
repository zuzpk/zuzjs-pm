/**
 * index.ts
 * Public API surface for @zuzjs/pm
 *
 * Programmatic usage:
 *   import { ZPMClient, pm, WorkerMode } from "@zuzjs/pm";
 *
 *   // Option A – singleton convenience client
 *   await pm.ensureDaemon();
 *   await pm.start({ name: "api", scriptPath: "./dist/server.js", port: 3000 });
 *
 *   // Option B – explicit client instance
 *   const client = new ZPMClient();
 *   await client.ensureDaemon();
 *   const stats = await client.stats("api");
 *
 * Daemon embedding (advanced):
 *   import { ProcessManager } from "@zuzjs/pm";
 *   const manager = new ProcessManager();
 *   await manager.start({ name: "worker", scriptPath: "./dist/worker.js" });
 */

export type {
    IPCCommand,
    IPCResponse, LivenessProbeConfig, ManagedProcess, WorkerConfig,
    WorkerStats
} from "./types";

export { WorkerMode, WorkerStatus } from "./types";

// Core classes
export { ProcessManager } from "./process-manager.js";
export { Worker } from "./worker";

// IPC
export { zpm, ZPMClient } from "./client";
export { getSocketPath } from "./ipc-server";

// Utilities
export { logger } from "./logger";
export { runProbe } from "./probe";
export { processStore } from "./store";

