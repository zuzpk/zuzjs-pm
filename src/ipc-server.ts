/**
 * ipc-server.ts
 * Unix-socket IPC server embedded inside daemon.ts.
 * Each message is a newline-delimited JSON string.
 */

import net from "node:net";
import os  from "node:os";
import fs  from "node:fs";
import path from "node:path";

import { logger }         from "./logger.js";
import { ProcessManager } from "./process-manager.js";
import { IPCCommand, IPCResponse } from "./types.js";

// Platform-aware socket path
export function getSocketPath(): string {
  if (os.platform() === "win32") {
    return path.join("\\\\.\\pipe", "zuzjs-pm");
  }
  return path.join(os.tmpdir(), "zuzjs-pm.sock");
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
