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

import { spawn } from "node:child_process";
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

    const isDev = process.env.NODE_ENV !== "production";

    const child = spawn(process.execPath, [this.daemonScript], {
      detached: true,
      // In dev: 'inherit' lets the daemon (and its workers) use THIS terminal.
      // In prod: 'ignore' detaches completely so you can close the terminal.
      stdio: isDev ? "inherit" : "ignore",
    });

    child.unref();

    // Wait for the socket to appear
    await this.waitForDaemon(8_000);
  }

  /** Kill the daemon by PID */
  public async killDaemon(): Promise<void> {
    const pidFile = path.join(os.tmpdir(), "zuz-pm.pid");
    if (!fs.existsSync(pidFile)) {
      throw new Error("Daemon PID file not found – is the daemon running?");
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[ZPM] Sent SIGTERM to daemon (PID ${pid})`);
    } catch (err) {
      throw new Error(`Failed to kill daemon: ${(err as Error).message}`);
    }
    finally {
      fs.unlinkSync(pidFile)
    }
  }

  public async getStore() : Promise<StoreInfo> {
    const info : IPCResponse = (await send({ cmd: "get-store" }, this.namespace)) as IPCResponse
    return info.ok == true ? info.data as ManagedProcess[] : null
  }

  public async getProcessByName(processName: string) : Promise<ManagedProcess | undefined> {
    const info : IPCResponse = (await send({ cmd: "get-store" }, this.namespace)) as IPCResponse
    const list : any[] = info.ok == true ? info.data as any[] : []
    return list.find(p => p.name == processName)
  }
  // Worker control

  public async startWorker(name: string): Promise<string> {
    const worker = await this.getWorkerByName(name)
    if ( worker ){
      return this.start(worker.getConfig())
    }
    logger.info(name, `Worker ${name} not found`)
    return `Worker ${name} not found`
  }

  public async start(config: WorkerConfig): Promise<string> {
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

    const worker = await this.getWorkerByName(oldName)

    if ( worker ){
      
      await this.stop(oldName)
      await this.delete(oldName)

      return await send({ 
        cmd: `add-worker`, 
        config: {
          ...worker.getConfig(),
          name: newName
        },
        autoStart
      })
      
    }

  }

  public async getWorkerByName(workerName: string) : Promise<Worker | null> {
    const worker = await send({ cmd: "find-worker", name: workerName }, this.namespace)
    return worker as Worker | null
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
}

// Convenience singleton
// For quick one-liners: import { zpm } from "@zuzjs/pm"

export const zpm = new ZPMClient();
