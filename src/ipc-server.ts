/**
 * ipc-server.ts
 * Unix-socket IPC server embedded inside daemon.ts.
 * Each message is a newline-delimited JSON string.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { logger } from "./logger.js";
import { ProcessManager } from "./process-manager.js";
import { IPCCommand, IPCResponse } from "./types.js";
import { Worker } from "./worker";

// Platform-aware socket path
export function getSocketPath(namespace: string = "zuz-pm"): string {
  if (os.platform() === "win32") {
    return path.join("\\\\.\\pipe", namespace);
  }
  return path.join(os.tmpdir(), `${namespace}.sock`);
}

export function startIPCServer(pm: ProcessManager): net.Server {
  const sockPath = getSocketPath();

  // Clean up stale socket file
  if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);

  const server = net.createServer((socket) => {
    let buf = "";

    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";          // last fragment, possibly incomplete

      for (const line of lines) {
        if (!line.trim()) continue;
        handleMessage(pm, socket, line);
      }
    });

    socket.on("error", (err) => {
      logger.error("IPC", "Socket error:", err.message);
    });
  });

  server.listen(sockPath, () => {
    logger.success("IPC", `Listening on ${sockPath}`);
  });

  server.on("error", (err) => {
    logger.error("IPC", "Server error:", err);
  });

  return server;
}

async function handleMessage(
  pm: ProcessManager,
  socket: net.Socket,
  raw: string
): Promise<void> {
  let cmd: IPCCommand;
  try {
    cmd = JSON.parse(raw) as IPCCommand;
  } catch {
    reply(socket, { ok: false, error: "Invalid JSON" });
    return;
  }

  try {
    let data: unknown = null;

    switch (cmd.cmd) {
      case "ping":
        data = "pong";
        break;

      case "start":
        await pm.start(cmd.config);
        data = `Started "${cmd.name}"`;
        break;

      case "stop":
        await pm.stop(cmd.name);
        data = `Stopped "${cmd.name}"`;
        break;

      case "restart":
        await pm.restart(cmd.name);
        data = `Restarted "${cmd.name}"`;
        break;

      case "delete":
        await pm.delete(cmd.name);
        data = `Deleted "${cmd.name}"`;
        break;

      case "stats":
        data = await pm.getStats(cmd.name);
        break;

      case "list":
        data = pm.list();
        break;

      case "logs":
          const targetName = cmd.name;
          const workersToStream: Worker[] = [];
          
          // 1. Determine which workers to watch
          if (targetName) {
            const worker = pm.getWorker(targetName);
            if (!worker) {
              socket.write(JSON.stringify({ ok: false, error: `Worker "${targetName}" not found` }) + "\n");
              return;
            }
            workersToStream.push(worker);
          } else {
            // Get all registered workers from the ProcessManager
            const allNames = pm.list();
            for (const name of allNames) {
              const w = pm.getWorker(name);
              if (w) workersToStream.push(w);
            }
          }

          if (workersToStream.length === 0) {
            socket.write(JSON.stringify({ ok: false, error: "No active workers to stream logs from" }) + "\n");
            return;
          }

          // Create a registry for cleanup
          const activeListeners: Array<{ child: any; onData: (d: Buffer) => void }> = [];

          // Attach listeners to each worker
          for (const worker of workersToStream) {
            const mp = worker.mp();
            // We stream from all children of the worker (in case of Cluster mode)
            for (const child of mp.children) {
              const onData = (data: Buffer) => {
                // Prefix with [name] if we are streaming multiple workers
                const prefix = targetName ? "" : `[${worker.name}] `;
                socket.write(JSON.stringify({ 
                  ok: true, 
                  data: `${prefix}${data.toString()}` 
                }) + "\n");
              };

              child.stdout?.on("data", onData);
              child.stderr?.on("data", onData);
              activeListeners.push({ child, onData });
            }
          }

          // Cleanup: Remove ALL listeners when the CLI/Socket disconnects
          socket.on("close", () => {
            for (const { child, onData } of activeListeners) {
              child.stdout?.off("data", onData);
              child.stderr?.off("data", onData);
            }
          });
          
        break;

      default:
        throw new Error(`Unknown command: ${(cmd as IPCCommand).cmd}`);
    }

    reply(socket, { ok: true, data });
  } catch (err: unknown) {
    reply(socket, { ok: false, error: String((err as Error).message ?? err) });
  }
}

function reply(socket: net.Socket, res: IPCResponse): void {
  if (!socket.writable) return;
  socket.write(JSON.stringify(res) + "\n");
}
