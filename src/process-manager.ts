/**
 * process-manager.ts
 * Top-level controller.  Owns a registry of Worker instances and
 * exposes the unified API used by both the IPC daemon and programmatic callers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  private readonly stateDir: string;
  private migrationAuditMessage: string | null = null;
  public readonly SNAPSHOT_FILE: string;

  constructor() {
    const namespace = process.env.ZPM_NAMESPACE ?? "zuz-pm";
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    this.stateDir = process.env.ZPM_STATE_DIR
      ?? (isRoot ? "/var/lib/zpm" : path.join(os.homedir(), ".zpm"));

    this.SNAPSHOT_FILE = path.join(this.stateDir, `snapshot.${namespace}.json`);
    this.migrateLegacySnapshot(namespace);
  }

  private migrateLegacySnapshot(namespace: string): void {
    try {
      const readSnapshotArray = (filePath: string): WorkerConfig[] | null => {
        try {
          if (!fs.existsSync(filePath)) return null;
          const raw = fs.readFileSync(filePath, "utf8").trim();
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      };

      const current = readSnapshotArray(this.SNAPSHOT_FILE);
      if (current && current.length > 0) return;

      const candidates = new Set<string>();
      const homeDir = os.homedir();
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

      // Current state directory legacy names.
      candidates.add(path.join(this.stateDir, "snapshot.json"));
      candidates.add(path.join(this.stateDir, `snapshot.${namespace}.json`));
      candidates.add(path.join(this.stateDir, "snapshot.zuz-pm.json"));
      candidates.add(path.join(this.stateDir, "snapshot.zuzjs-pm.json"));

      // Old per-user location used by earlier versions.
      candidates.add(path.join(homeDir, ".zpm", "snapshot.json"));
      candidates.add(path.join(homeDir, ".zpm", "snapshot.zuz-pm.json"));
      candidates.add(path.join(homeDir, ".zpm", "snapshot.zuzjs-pm.json"));

      // When running as root service, older snapshots were often under /root/.zpm.
      if (isRoot) {
        candidates.add(path.join("/root", ".zpm", "snapshot.json"));
        candidates.add(path.join("/root", ".zpm", "snapshot.zuz-pm.json"));
        candidates.add(path.join("/root", ".zpm", "snapshot.zuzjs-pm.json"));
      }

      for (const source of candidates) {
        if (!source || source === this.SNAPSHOT_FILE) continue;
        const parsed = readSnapshotArray(source);
        if (!parsed || parsed.length === 0) continue;

        const dir = path.dirname(this.SNAPSHOT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(this.SNAPSHOT_FILE, JSON.stringify(parsed, null, 2));
        this.migrationAuditMessage = `Snapshot migration imported ${parsed.length} workers from ${source} -> ${this.SNAPSHOT_FILE}`;
        logger.warn("daemon", this.migrationAuditMessage);
        return;
      }
    } catch (err: any) {
      logger.warn("daemon", `Legacy snapshot migration skipped: ${err?.message ?? String(err)}`);
    }
  }

  public consumeMigrationAudit(): string | null {
    const msg = this.migrationAuditMessage;
    this.migrationAuditMessage = null;
    return msg;
  }

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
        logger.info("ZPM", `Refreshing worker "${config.name}" with latest config`);
        await _worker.stop();

        const worker = new Worker(config);
        this.workers.set(config.name, worker);
        await worker.start();
        this.saveSnapshot();
        return;
      }

      logger.warn("ZPM", `Worker "${pc.cyan(config.name)}" is ${pc.cyan(state?.status)} - use restart()`);
      return;

    }

    const worker = new Worker(config);
    this.workers.set(config.name, worker);
    await worker.start();

    this.saveSnapshot();

  }

  public async stop(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.stop();
    this.saveSnapshot();
  }

  public async restart(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.restart();
    this.saveSnapshot();
  }

  public async delete(name: string): Promise<void> {
    const worker = this.require(name);
    await worker.stop();
    this.workers.delete(name);
    processStore.delete(name);
    this.saveSnapshot();
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

  /**
   * Returns a list of all worker names.
   */
  public list(): string[] {
    return [...this.workers.keys()];
  }

  /**
   * Returns a list of all worker with their configs and statuses.  Used for snapshot persistence.
   */
  public getAllConfigs(): WorkerConfig[] {
    return Array.from(this.workers.values()).map(w => w.getConfig());
  }

  // Graceful shutdown
  public async stopAll(): Promise<void> {
    logger.info("PM", "Stopping all workers...");
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    logger.info("PM", "All workers stopped.");
    this.saveSnapshot();
  }

  public getWorker(name: string): Worker | null {
    const worker = this.workers.get(name);
    if (!worker) {
      logger.error(name, `Worker Not Found`)
      return null
    }
    return worker;
  }

  public async addWorker(config: WorkerConfig, autoStart: boolean): Promise<void> {
    const worker = new Worker(config);
    this.workers.set(config.name, worker);
    if ( autoStart ) await worker.start();
    this.saveSnapshot();
  }

  // Private

  private require(name: string): Worker {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    return worker;
  }

  public saveSnapshot(): void {
    try {

      const dir = path.dirname(this.SNAPSHOT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const configs = this.getAllConfigs(); 
      fs.writeFileSync(this.SNAPSHOT_FILE, JSON.stringify(configs, null, 2));
      logger.info("daemon", `Saved snapshot of ${configs.length} workers.`);

    } catch (err : any) {
      logger.error("daemon", "Failed to save snapshot:", err.message);
    }
  }


}
