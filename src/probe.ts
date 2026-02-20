/**
 * probe.ts
 * Liveness probes: http | tcp | exec
 * Returns true if the target is alive, false otherwise.
 */

import { exec } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { LivenessProbeConfig } from "./types.js";

// Individual probe strategies

function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("error",   () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function probeTcp(target: string, timeoutMs: number): Promise<boolean> {
  // target format: "host:port"
  const [host, portStr] = target.split(":");
  const port = Number(portStr);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error",   () => resolve(false));
  });
}

function probeExec(command: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exec(command, (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
}

// Public helper

export async function runProbe(cfg: LivenessProbeConfig): Promise<boolean> {
  const timeoutMs = (cfg.timeoutSeconds ?? 5) * 1000;

  switch (cfg.type) {
    case "http": return probeHttp(cfg.target, timeoutMs);
    case "tcp":  return probeTcp(cfg.target, timeoutMs);
    case "exec": return probeExec(cfg.target, timeoutMs);
    default:     return false;
  }
}
