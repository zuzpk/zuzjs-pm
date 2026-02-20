/**
 * process-manager.ts
 * Top-level controller.  Owns a registry of Worker instances and
 * exposes the unified API used by both the IPC daemon and programmatic callers.
 */

import { logger } from "./logger";
import { processStore } from "./store";
import {
  WorkerConfig,
  WorkerStats
} from "./types";
import { Worker } from "./worker";

export class ProcessManager {
  private workers = new Map<string, Worker>();

  // CRUD

  public async start(config: WorkerConfig): Promise<void> {
    if (this.workers.has(config.name)) {
      logger.warn("PM", `Worker "${config.name}" already registered – use restart()`);
      return;
    }
    const worker = new Worker(config);
    this.workers.set(config.name, worker);
    await worker.start();
  }

  public async stop(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.stop();
  }

  public async restart(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.restart();
  }

  public async delete(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.stop();
    this.workers.delete(name);
    processStore.delete(name);
    logger.info("PM", `Deleted worker "${name}"`);
  }

  // Telemetry

  public async getStats(name?: string): Promise<WorkerStats[]> {
    if (name) {
      const worker = this.require(name);
      return [await worker.getStats()];
    }
    const all = await Promise.all(
      [...this.workers.values()].map((w) => w.getStats())
    );
    return all;
  }

  public list(): string[] {
    return [...this.workers.keys()];
  }

  // Graceful shutdown

  public async stopAll(): Promise<void> {
    logger.info("PM", "Stopping all workers...");
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    logger.info("PM", "All workers stopped.");
  }

  // Private

  private require(name: string): Worker {
    const worker = this.workers.get(name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    return worker;
  }
}
