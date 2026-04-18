/**
 * client.ts
 * Programmatic library API for @zuzjs/pm.
 *
 * Usage:
 *   import { ZPMClient } from "@zuzjs/pm";
 *   const pm = new ZPMClient();
 *   await pm.ensureDaemon();           // spawn daemon if not running
 *   await pm.start({ name: "api", scriptPath: "./dist/server.js", port: 3000 });
 *   const stats = await pm.stats("api");
 *   await pm.stop("api");
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { getSocketPath } from "./ipc-server";
import { logger } from "./logger";
import {
  IPCCommand,
  IPCResponse,
  ManagedProcess,
  StoreInfo,
  WorkerConfig,
  WorkerStats,
} from "./types";
import { Worker } from "./worker";

// Internal IPC transport

function send(cmd: IPCCommand, namespace: string = "zuz-pm"): Promise<unknown> {
  return new Promise((resolve, reject) => {

    const socket = net.createConnection(getSocketPath(namespace));
    let   buf    = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(cmd) + "\n");
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res: IPCResponse = JSON.parse(line);
          socket.destroy();
          if (res.ok) resolve(res.data);
          else        reject(new Error(res.error));
        } catch (e) {
          socket.destroy();
          reject(e);
        }
      }
    });

    socket.on("error", (err) => reject(err));
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("IPC timeout"));
    });
  });
}

// Public client

export class ZPMClient {
  private readonly daemonScript: string;
  private namespace: string;

  constructor(conf?: {
    daemonScript?: string;
    namespace?: string;
  }) {
    this.namespace = conf?.namespace ?? "zuz-pm";
    // Default: resolved from the same package dist folder
    this.daemonScript = conf?.daemonScript ?? path.join(__dirname, "daemon.js");
  }

  // Daemon management

  /** Returns true if daemon is reachable */
  public async isDaemonRunning(): Promise<boolean> {
    try {
      logger.info(`[ZPM]`, `Daemon is Running :?`)
      await send({ cmd: "ping" }, this.namespace);
      return true;
    } catch {
      logger.info(`[ZPM]`, `Daemon is not running.`)
      return false;
    }
  }

  /** Spawn the daemon detached if it is not already running */
  public async ensureDaemon(): Promise<void> {
    
    const isRunning = await this.isDaemonRunning()
    if (isRunning) {
      // this.killDaemon()
      return;
    }
    // if (isRunning) return;
    
    logger.info("Starting ZPM daemon...");

    const daemonStdio = process.env.ZPM_DAEMON_STDIO === "inherit" ? "inherit" : "ignore";

    const child = spawn(process.execPath, [this.daemonScript], {
      detached: true,
      // Default to fully detached daemon IO. Opt into inherited IO only when
      // explicitly requested via ZPM_DAEMON_STDIO=inherit.
      stdio: daemonStdio,
      env: { ...process.env, ZPM_NAMESPACE: this.namespace },
    });

    child.unref();

    // Wait for the socket to appear
    await this.waitForDaemon(8_000);
  }

  /** Kill the daemon by PID */
  public async killDaemon(): Promise<void> {
    const pidFile = path.join(os.tmpdir(), `${this.namespace}.pid`);
    if (!fs.existsSync(pidFile)) {
      console.log(`[ZPM] No daemon PID file for namespace "${this.namespace}" (already stopped).`);
      return;
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // ignore unlink issues for malformed pid files
      }
      throw new Error("Daemon PID file is invalid and was cleaned up.");
    }

    try {
      process.kill(pid, "SIGTERM");
      console.log(`[ZPM] Sent SIGTERM to daemon (PID ${pid})`);
    } catch (err: any) {
      if (err?.code === "ESRCH") {
        console.log(`[ZPM] Daemon PID ${pid} is not running (stale pid file). Cleaning up.`);
      } else if (err?.code === "EPERM") {
        const killedWithSudo = this.trySudoKill(pid);
        if (!killedWithSudo) {
          throw new Error(
            `Permission denied while killing daemon PID ${pid}. ` +
            `Run with sudo or grant permission: sudo zpm --namespace ${this.namespace} kill-daemon`
          );
        }
      } else {
        throw new Error(`Failed to kill daemon: ${err.message}`);
      }
    }
    finally {
      try {
        fs.unlinkSync(pidFile)
      } catch {
        // best effort cleanup
      }
    }
  }

  /**
   * Deep restart for daemon lifecycle hygiene:
   * - discover PID from pid file or socket owner
   * - terminate if possible
   * - clean stale pid/socket entries
   * - spawn a fresh daemon
   */
  public async restartDaemon(): Promise<void> {
    const pidFile = path.join(os.tmpdir(), `${this.namespace}.pid`);
    const socketPath = getSocketPath(this.namespace);

    const pidFromFile = this.readPidFile(pidFile);
    const pidFromSocket = this.findSocketOwnerPid(socketPath);
    const pid = pidFromFile ?? pidFromSocket;

    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[ZPM] Sent SIGTERM to daemon (PID ${pid})`);
      } catch (err: any) {
        if (err?.code !== "ESRCH") {
          if (err?.code === "EPERM") {
            const killedWithSudo = this.trySudoKill(pid);
            if (!killedWithSudo) {
              throw new Error(
                `Permission denied while killing daemon PID ${pid}. ` +
                `Run with sudo or grant permission: sudo zpm --namespace ${this.namespace} restart-daemon`
              );
            }
          } else {
            throw new Error(`Failed to kill daemon: ${err.message}`);
          }
        }
      }
    }

    await this.waitForDaemonDown(5_000);

    // Best-effort stale artifact cleanup before a fresh boot.
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {
      this.trySudoUnlink(pidFile);
    }

    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      this.trySudoUnlink(socketPath);
    }

    await this.ensureDaemon();
  }

  public async getStore() : Promise<StoreInfo> {
    const data = (await send({ cmd: "get-store" }, this.namespace)) as ManagedProcess[]
    return Array.isArray(data) ? data : null
  }

  public async getProcessByName(processName: string) : Promise<ManagedProcess | undefined> {
    const list = (await this.getStore()) as any[] | null
    if (!list) return undefined;
    return list.find(p => p.name == processName)
  }
  // Worker control

  public async startWorker(name: string): Promise<string> {
    const config = await this.getWorkerByName(name)
    if ( config ){
      return this.start(config)
    }
    logger.info(name, `Worker ${name} not found`)
    return `Worker ${name} not found`
  }

  public async start(config: WorkerConfig): Promise<string> {
    const existing = await this.getWorkerByName(config.name)
    if ( existing ){
      config = {
        ...existing,
        ...config,
      }
    }
    return send({ cmd: "start", name: config.name, config }, this.namespace) as Promise<string>;
  }

  public async stop(name: string): Promise<string> {
    return send({ cmd: "stop", name }, this.namespace) as Promise<string>;
  }

  public async restart(name: string): Promise<string> {
    return send({ cmd: "restart", name }, this.namespace) as Promise<string>;
  }

  public async delete(name: string): Promise<string> {
    return send({ cmd: "delete", name }, this.namespace) as Promise<string>;
  }

  /** Replace worker with new name */
  public async replaceWorker(oldName: string, newName: string, autoStart: boolean){

    const workerConfig = await this.getWorkerByName(oldName)

    if ( workerConfig ){
      
      await this.stop(oldName)
      await this.delete(oldName)

      return await send({ 
        cmd: `add-worker`, 
        config: {
          ...workerConfig,
          name: newName
        },
        autoStart
      })
      
    }

  }

  public async getWorkerByName(workerName: string) : Promise<WorkerConfig | null> {
    const config = await send({ cmd: "find-worker", name: workerName }, this.namespace)
    return config as WorkerConfig | null
  }

  // Telemetry

  public async stats(name?: string): Promise<WorkerStats[]> {
    return send({ cmd: "stats", name }, this.namespace) as Promise<WorkerStats[]>;
  }

  public async list(): Promise<string[]> {
    return send({ cmd: "list" }, this.namespace) as Promise<string[]>;
  }

  // Helpers

  private waitForDaemon(timeoutMs: number): Promise<void> {
    const start    = Date.now();
    const interval = 200;

    return new Promise((resolve, reject) => {
      const check = () => {
        this.isDaemonRunning().then((alive) => {
          if (alive) return resolve();
          if (Date.now() - start > timeoutMs) {
            return reject(new Error("Daemon did not start in time"));
          }
          setTimeout(check, interval);
        });
      };
      setTimeout(check, interval);
    });
  }

  private waitForDaemonDown(timeoutMs: number): Promise<void> {
    const start = Date.now();
    const interval = 200;

    return new Promise((resolve, reject) => {
      const check = () => {
        this.isDaemonRunning().then((alive) => {
          if (!alive) return resolve();
          if (Date.now() - start > timeoutMs) {
            return reject(new Error("Daemon did not stop in time"));
          }
          setTimeout(check, interval);
        });
      };
      setTimeout(check, interval);
    });
  }

  private readPidFile(pidFile: string): number | null {
    try {
      if (!fs.existsSync(pidFile)) return null;
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number(raw);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private findSocketOwnerPid(socketPath: string): number | null {
    const escaped = socketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Linux path: ss provides pid metadata for listening unix sockets.
    try {
      const out = execSync(`ss -xlp | grep '${escaped}'`, {
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      }).toString();
      const match = out.match(/pid=(\d+)/);
      if (match) return Number(match[1]);
    } catch {
      // continue fallback
    }

    // Fallback: lsof can also expose the owning process id.
    try {
      const out = execSync(`lsof -t '${socketPath}'`, {
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      }).toString().trim();
      const pid = Number(out.split("\n")[0]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // no owner found
    }

    return null;
  }

  private trySudoKill(pid: number): boolean {
    try {
      execSync(`sudo -n kill ${pid}`, {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });
      console.log(`[ZPM] Used sudo to stop daemon PID ${pid}.`);
      return true;
    } catch {
      return false;
    }
  }

  private trySudoUnlink(filePath: string): boolean {
    try {
      execSync(`sudo -n rm -f '${filePath.replace(/'/g, "'\\''")}'`, {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// Convenience singleton
// For quick one-liners: import { zpm } from "@zuzjs/pm"

export const zpm = new ZPMClient();
