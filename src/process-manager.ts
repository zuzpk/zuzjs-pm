/**
 * process-manager.ts
 * Top-level controller.  Owns a registry of Worker instances and
 * exposes the unified API used by both the IPC daemon and programmatic callers.
 */

import pc from "picocolors";
import { logger } from "./logger";
import { processStore } from "./store";
import {
  WorkerConfig,
  WorkerStats,
  WorkerStatus
} from "./types";
import { Worker } from "./worker";

export class ProcessManager {
  private workers = new Map<string, Worker>();

  // CRUD

  public async start(config: WorkerConfig): Promise<void> {

    const _worker = this.workers.get(config.name)

    if (_worker) {

      const state = processStore.get(config.name);
    
      // If it exists but is stopped/crashed, just trigger the start on the existing instance
      if (
        state?.status === WorkerStatus.Stopped || 
        state?.status === WorkerStatus.Crashed || 
        state?.status === WorkerStatus.Errored
      ) {
        
        logger.info("ZPM", `Resuming existing worker "${config.name}"`);
        await _worker.start();
        return;
      }

      logger.warn("ZPM", `Worker "${pc.cyan(config.name)}" is ${pc.cyan(state?.status)} - use restart()`);
      return;

    }

    const worker = new Worker(config);
    this.workers.set(config.name, worker);
    await worker.start();
  }

  public async stop(name: string): Promise<void> {
    const worker = this.require(name);
    if ( !worker ) return;
    await worker.stop();
  }

  public async restart(name: string): Promise<void> {
    const worker = this.require(name);
    if ( !worker ) return;
    await worker.restart();
  }

  public async delete(name: string): Promise<void> {
    const worker = this.require(name);
    if ( !worker ) return;
    await worker.stop();
    this.workers.delete(name);
    processStore.delete(name);
    logger.info("PM", `Deleted worker "${name}"`);
  }

  // Telemetry

  public async getStats(name?: string): Promise<WorkerStats[]> {
    if (name) {
      const worker = this.require(name);
      if ( !worker ) return [];
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

  public getWorker(name: string): Worker | null {
    const worker = this.workers.get(name);
    if (!worker) {
      logger.error(name, `Worker Not Found`)
      return null
    }
    return worker;
  }


  // Private

  private require(name: string): Worker | null {
    const worker = this.workers.get(name);
    if (!worker) {
      logger.error(name, `Worker Not Found`)
      // throw new Error(`Worker "${name}" not found`);
      return null;
    }
    return worker;
  }
}
