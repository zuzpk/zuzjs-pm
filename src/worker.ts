/**
 * worker.ts
 * Manages the full lifecycle of one application entry:
 *   – Fork mode  : child_process.spawn  (isolated scripts, daemons, etc.)
 *   – Cluster mode: node:cluster workers (load-balanced HTTP servers)
 */

import chokidar, { FSWatcher } from "chokidar";
import { ChildProcess, exec, spawn } from "node:child_process";
import { Worker as ClusterWorker } from "node:cluster";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
// @ts-ignore – pidusage has types but some bundlers complain
import pidusage from "pidusage";

import { logger } from "./logger";
import { runProbe } from "./probe";
import { processStore } from "./store";
import {
  ManagedProcess,
  WorkerConfig,
  WorkerMode,
  WorkerStats,
  WorkerStatus,
} from "./types.js";

// Defaults
const DEFAULT_KILL_TIMEOUT = 5_000;   // ms before SIGKILL
const DEFAULT_MAX_BACKOFF  = 16_000;  // ms
const INIT_BACKOFF         = 1_000;   // ms
const STABILITY_WINDOW     = 5_000;   // ms uptime before backoff resets

// Helpers
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", function (this: net.Server) {
        this.close(() => resolve(true));
      })
      .listen(port);
  });
}

async function _freePort(port: number): Promise<void> {
  if (await isPortFree(port)) return;
  logger.warn("port", `Port ${port} busy – attempting fuser kill`);
  
  await new Promise<void>((resolve) =>
    exec(`fuser -k -9 ${port}/tcp 2>/dev/null; true`, () => resolve())
  );
  // brief settle
  await new Promise((r) => setTimeout(r, 500));
}

async function freePort(port: number): Promise<void> {
  if (await isPortFree(port)) return;
  
  // macOS specific port killing
  const cmd = os.platform() === 'darwin' 
    ? `lsof -ti :${port} | xargs kill -9 2>/dev/null || true`
    : `fuser -k -9 ${port}/tcp 2>/dev/null; true`;

  await new Promise<void>((resolve) => exec(cmd, () => resolve()));
  await new Promise((r) => setTimeout(r, 800)); // Give OS time to release
}


function _gracefulKill(
  proc: ChildProcess | ClusterWorker,
  timeout: number
): void {
  const pid = (proc as ClusterWorker).process?.pid ?? (proc as ChildProcess).pid;
  if (!pid) return;

  try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ return; }

  const killer = setTimeout(() => {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }, timeout);

  // Clear killer if the process actually exits before timeout
  (proc as ChildProcess).once?.("exit", () => clearTimeout(killer));
  (proc as ClusterWorker).once?.("exit", () => clearTimeout(killer));
}

async function gracefulKill(
  proc: ChildProcess | ClusterWorker,
  timeout: number
): Promise<void> {
  const pid = (proc as ClusterWorker).process?.pid ?? (proc as ChildProcess).pid;
  if (!pid) return;

  return new Promise((resolve) => {
    let isDone = false;

    const cleanup = () => {
      if (isDone) return;
      isDone = true;
      clearTimeout(killer);
      resolve();
    };

    // Listen for the standard exit event
    (proc as ChildProcess).once?.("exit", cleanup);
    (proc as ClusterWorker).once?.("exit", cleanup);

    // Attempt SIGTERM
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      return cleanup(); // Process is already gone
    }

    // Forceful fallback
    const killer = setTimeout(() => {
      try {
        // If still alive, send the unblockable SIGKILL
        process.kill(pid, "SIGKILL");
        
        // On Unix, we might need a tiny delay for the OS to reap the process
        setTimeout(cleanup, 100); 
      } catch (e) {
        cleanup();
      }
    }, timeout);

    // Final safety: check if PID is actually gone from the OS table
    const checkInterval = setInterval(() => {
      try {
        process.kill(pid, 0); // signal 0 checks for existence
      } catch (e) {
        // If this throws, the process is gone
        clearInterval(checkInterval);
        cleanup();
      }
    }, 500);
  });
}

// Worker class
export class Worker {
  private readonly cfg: WorkerConfig;
  public readonly name: string;
  private watcher: FSWatcher | null = null;

  constructor(config: WorkerConfig) {
    this.cfg  = { mode: WorkerMode.Fork, instances: 1, ...config };
    this.name = config.name;
    this.initStore();
  }

  // Public lifecycle

  public async start(): Promise<void> {
    const mp = this.mp();
    
    // If it's already running, don't double-start
    if (mp.status === WorkerStatus.Running || mp.status === WorkerStatus.Starting) {
      logger.warn(this.name, "Already running – ignoring start()");
      return;
    }

    // Reset backoff and failures for a fresh manual start
    this.patch({ 
      status: WorkerStatus.Starting, 
      isRestarting: false,
      children: [],          // Ensure no ghost pids are tracked
      restartCount: 0, 
      backoffTime: INIT_BACKOFF,
      probeFailures: 0,
      startTime: null 
    });

    this.clearTimers(); 
    this.stopProbe();

    logger.info(this.name, "Initializing fresh start...");
  
    try {
      await this.spawnAll();
      if (this.cfg.devMode) this.watchFiles();
    } catch (err: any) {
      this.patch({ status: WorkerStatus.Errored });
      logger.error(this.name, `Start failed: ${err.message}`);
    }
  }

  // public async start(): Promise<void> {
  //   const mp = this.mp();
  //   if (mp.status === WorkerStatus.Running || mp.status === WorkerStatus.Starting) {
  //     logger.warn(this.name, "Already running – ignoring start()");
  //     return;
  //   }
  //   this.patch({ status: WorkerStatus.Starting });
  //   await this.spawnAll();
  //   if (this.cfg.devMode) this.watchFiles();
  // }

  // public async start(): Promise<void> {
  //   const mp = this.mp();
  //   if (mp.status === WorkerStatus.Running || mp.status === WorkerStatus.Starting) {
  //     logger.warn(this.name, "Already running – ignoring start()");
  //     return;
  //   }
  //   this.patch({ status: WorkerStatus.Starting });
  //   await this.spawnAll();
  //   if (this.cfg.devMode) this.watchFiles();
  // }

  public async stop(): Promise<void> {
  const mp = this.mp();
  if (mp.status === WorkerStatus.Stopping) return;

  this.patch({ status: WorkerStatus.Stopping, isRestarting: false });
  logger.info(this.name, `Stopping ${mp.children.length} instances...`);

  this.clearTimers();
  this.stopProbe();
  this.stopWatcher();

  try {
    // We add a total safety timeout here so ZPM never hangs indefinitely
    await Promise.race([
      Promise.all(mp.children.map(c => gracefulKill(c, this.cfg.killTimeout ?? DEFAULT_KILL_TIMEOUT))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Termination timeout")), 10000))
    ]);
  } catch (err: any) {
    logger.error(this.name, `Stop timed out, forcing state reset: ${err.message || `UNKNOWN`}`);
  }

  this.patch({ children: [], status: WorkerStatus.Stopped, startTime: null });
  this.stopWatcher();
  logger.success(this.name, "Stopped.");
}

  public async _stop(): Promise<void> {
    const mp = this.mp();
    this.patch({ status: WorkerStatus.Stopping, isRestarting: false });
    this.clearTimers();
    this.stopProbe();

    for (const child of mp.children) {
      gracefulKill(child, this.cfg.killTimeout ?? DEFAULT_KILL_TIMEOUT);
    }

    this.stopWatcher();
    this.patch({ children: [], status: WorkerStatus.Stopped, startTime: null });
    logger.info(this.name, "Stopped.");
  }

  public async restart(): Promise<void> {

    const mp = this.mp();

    if (mp.isRestarting) return;

    logger.info(this.name, "Restarting...");
    
    this.patch({ isRestarting: true, status: WorkerStatus.Stopping });

    this.clearTimers();
    this.stopProbe();

    await Promise.all(
      mp.children.map(child => 
        gracefulKill(child, this.cfg.killTimeout ?? DEFAULT_KILL_TIMEOUT)
      )
    );

    // After all are dead, we trigger a fresh spawn
    this.patch({ isRestarting: false, children: [] });
    // await this.spawnAll();
    // spawnAll is called from exit handler when isRestarting = true
  }

  public async _restart(): Promise<void> {
    logger.info(this.name, "Restarting...");
    const mp = this.mp();
    this.patch({ isRestarting: true });
    this.clearTimers();
    this.stopProbe();

    for (const child of mp.children) {
      gracefulKill(child, this.cfg.killTimeout ?? DEFAULT_KILL_TIMEOUT);
    }
    // spawnAll is called from exit handler when isRestarting = true
  }

  public async getStats(): Promise<WorkerStats> {
    const mp   = this.mp();
    const pid  = mp.children[0]?.pid ?? null;
    let cpu: number | null = null;
    let memoryRss: number | null = null;
    let memoryHeap: number | null = null;

    if (pid && mp.status === WorkerStatus.Running) {
      try {
        const usage = await pidusage(pid);
        cpu = usage.cpu;
        memoryRss = usage.memory;
      } catch { /* process may have just exited */ }
    }

    return {
      name:         this.name,
      status:       mp.status,
      pid,
      uptime:       mp.startTime ? Date.now() - mp.startTime : null,
      restartCount: mp.restartCount,
      cpu,
      memoryRss,
      memoryHeap,
      mode:         this.cfg.mode ?? WorkerMode.Fork,
      instances:    mp.children.length,
    };
  }

  // Internal spawn logic

  private async spawnAll(): Promise<void> {
    if (!fs.existsSync(this.cfg.scriptPath)) {
      logger.error(this.name, `Script not found: ${this.cfg.scriptPath}. Waiting for build...`);
      this.patch({ status: WorkerStatus.Errored });
      return;
    }

    if (this.cfg.port) await freePort(this.cfg.port);

    const mode      = this.cfg.mode ?? WorkerMode.Fork;
    const instances = mode === WorkerMode.Cluster
      ? (this.cfg.instances ?? os.cpus().length)
      : 1;

    const children: ChildProcess[] = [];

    for (let i = 0; i < instances; i++) {
      const child = this.forkChild();
      if (child) children.push(child);
    }

    if (children.length === 0) {
      logger.error(this.name, "Failed to spawn any instances.");
      this.patch({ status: WorkerStatus.Stopped }); // If spawn failed, stay Stopped
      return;
    }

    this.patch({
      children,
      startTime:    Date.now(),
      status:       WorkerStatus.Running,
    });

    logger.success(this.name, `Started ${children.length} instance(s) [${mode}]`);

    // Stability window – reset backoff after sustained uptime
    const stabilityTimer = setTimeout(() => {
      const mp = this.mp();
      if (mp.status === WorkerStatus.Running) {
        this.patch({ backoffTime: INIT_BACKOFF, restartCount: 0 });
        logger.success(this.name, "Process is stable.");
      }
    }, STABILITY_WINDOW);

    this.patch({ stabilityTimer });

    // Start liveness probe if configured
    if (this.cfg.probe) this.startProbe();
  }

  private forkChild(): ChildProcess | null {
    try {

    // Check if the script is actually a binary or if we should use node
    const executable = this.cfg.scriptPath.endsWith('.js') ? 'node' : this.cfg.scriptPath;
    const args = this.cfg.scriptPath.endsWith('.js') 
      ? [this.cfg.scriptPath, ...(this.cfg.args ?? [])]
      : [...(this.cfg.args ?? [])];

      const child = spawn(
        executable, 
        args, 
        {
          cwd: path.dirname(path.resolve(this.cfg.scriptPath, '..')), // Go up one level from dist
          stdio:    ["ignore", "pipe", "pipe"],
          env:      { ...process.env, ...(this.cfg.env ?? {}), NODE_ENV: this.cfg.devMode ? "development" : "production" },
          detached: false,
          shell:    false,
        }
      );

      this.setupLogging(child)

      const startTime = Date.now();

      child.on("error", (err) => {
        logger.error(this.name, "Spawn error:", err);
      });

      child.on("exit", (code, signal) => {
        const uptime = Date.now() - startTime;
        this.onChildExit(child, code, signal, uptime);
      });

      return child;
    } catch (err) {
      logger.error(this.name, "Failed to fork child:", err);
      return null;
    }
  }

  private onChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    uptime: number
  ): void {
    const mp = this.mp();

    // Remove this child from the active list
    const remaining = mp.children.filter((c) => c !== child);
    this.patch({ children: remaining });

    if (mp.status === WorkerStatus.Stopping) return; // intentional stop

    logger.warn(this.name, `Process exited (code=${code}, signal=${signal}, uptime=${uptime}ms)`);

    if (mp.isRestarting) {
      // All children need to be gone before we re-spawn
      if (remaining.length === 0) {
        this.patch({ isRestarting: false });
        this.spawnAll();
      }
      return;
    }

    if (code !== 0 && code !== null) {
      this.patch({ status: WorkerStatus.Crashed });

      if (uptime < 1_500) {
        logger.error(
          this.name,
          `Immediate crash (${uptime}ms) – likely a syntax/build error. Waiting for next file change.`
        );
        return;
      }

      this.scheduleRestart();
    }
  }

  // Exponential backoff restart

  private scheduleRestart(): void {
    const mp       = this.mp();
    const backoff  = mp.backoffTime;
    const maxBack  = this.cfg.maxBackoff ?? DEFAULT_MAX_BACKOFF;

    logger.warn(
      this.name,
      `Scheduling restart in ${backoff}ms (attempt #${mp.restartCount + 1})`
    );

    const restartTimer = setTimeout(async () => {
      this.patch({
        restartCount: mp.restartCount + 1,
        backoffTime:  Math.min(backoff * 2, maxBack),
      });
      await this.spawnAll();
    }, backoff);

    this.patch({ restartTimer });
  }

  // Liveness prob

  private startProbe(): void {
    const probeCfg = this.cfg.probe!;
    const intervalMs = (probeCfg.intervalSeconds ?? 10) * 1000;
    const threshold  = probeCfg.failureThreshold ?? 3;

    const tick = async () => {
      const mp    = this.mp();
      if (mp.status !== WorkerStatus.Running) return;

      const alive = await runProbe(probeCfg);
      if (alive) {
        if (mp.probeFailures > 0) this.patch({ probeFailures: 0 });
        return;
      }

      const failures = mp.probeFailures + 1;
      this.patch({ probeFailures: failures });
      logger.warn(this.name, `Liveness probe failed (${failures}/${threshold})`);

      if (failures >= threshold) {
        logger.error(this.name, "Liveness probe threshold exceeded – restarting.");
        this.patch({ probeFailures: 0 });
        await this.restart();
      }
    };

    const probeTimer = setInterval(tick, intervalMs);
    this.patch({ probeTimer });
  }

  private stopProbe(): void {
    const { probeTimer } = this.mp();
    if (probeTimer) {
      clearInterval(probeTimer);
      this.patch({ probeTimer: null, probeFailures: 0 });
    }
  }

  // File watcher (dev mode)

  private watchFiles(): void {
    this.stopWatcher();
    const dir = path.dirname(this.cfg.scriptPath);

    this.watcher = chokidar.watch(dir, {
      ignored:       [/node_modules/, /\.pid$/],
      persistent:    true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1_500, pollInterval: 500 },
    });

    this.watcher.on("all", (event, filePath) => {
      if (event === "change" || event === "add") {
        logger.info(this.name, `File ${event}: ${path.basename(filePath)} – restarting`);
        this.restart();
      }
    });

    this.watcher.on("error", (err) => logger.error(this.name, "Watcher error:", err));
    this.watcher.on("ready", () => logger.info(this.name, `Watching ${dir}`));
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // Store helpers

  private initStore(): void {
    processStore.set(this.name, {
      config:        this.cfg,
      children:      [],
      status:        WorkerStatus.Stopped,
      startTime:     null,
      restartCount:  0,
      backoffTime:   INIT_BACKOFF,
      restartTimer:  null,
      stabilityTimer:null,
      probeTimer:    null,
      probeFailures: 0,
      isRestarting:  false,
    });
  }

  public mp(): ManagedProcess {
    return processStore.get(this.name)!;
  }

  private _patch(partial: Partial<ManagedProcess>): void {
    processStore.set(this.name, { ...this.mp(), ...partial });
  }

  private patch(partial: Partial<ManagedProcess>): void {
    const current = this.mp();
    
    // If status is changing, log the transition automatically
    if (partial.status && partial.status !== current.status) {
      logger.info(
        this.name, 
        `[STATE] ${current.status} ➔ ${partial.status}${partial.isRestarting ? ' (Restarting)' : ''}`
      );
    }

    processStore.set(this.name, { ...current, ...partial });
  }

  private clearTimers(): void {
    const { restartTimer, stabilityTimer } = this.mp();
    if (restartTimer)  clearTimeout(restartTimer);
    if (stabilityTimer) clearTimeout(stabilityTimer);
    this.patch({ restartTimer: null, stabilityTimer: null });
  }

  private setupLogging(child: ChildProcess) {

    const wsUrl = this.cfg.logs?.wsUrl;
    let ws: WebSocket | null = null;

    if (wsUrl) {
      ws = new WebSocket(wsUrl);
      ws.on('open', () => logger.debug(this.name, "Connected to log collector"));
      ws.on('error', (err: any) => logger.error(this.name, "Log Collector WS Error", err.message));
    }

    const handleData = (data: Buffer) => {
      const message = data.toString();
      
      // 1. Print to local terminal if in dev mode
      if (this.cfg.devMode) process.stdout.write(`[${this.name}] ${message}`);

      // 2. Stream to ZPanel WebSocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          app: this.name,
          timestamp: Date.now(),
          log: message
        }));
      }
    };

    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

  }

}
