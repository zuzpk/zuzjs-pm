/**
 * logger.ts
 * Thin, zero-dependency logger.
 * Drop-in swap: replace with @zuzjs/core logger when available.
 */

export type LogLevel = "info" | "warn" | "error" | "debug" | "success";

const COLORS: Record<LogLevel, string> = {
  info:    "\x1b[36m",   // cyan
  warn:    "\x1b[33m",   // yellow
  error:   "\x1b[31m",   // red
  debug:   "\x1b[90m",   // grey
  success: "\x1b[32m",   // green
};
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";

function timestamp() {
  return new Date().toISOString();
}

function log(level: LogLevel, tag: string, ...args: unknown[]) {
  const color  = COLORS[level];
  const prefix = `${BOLD}${color}[ZPM/${tag.toUpperCase()}]${RESET} ${timestamp()}`;
  // eslint-disable-next-line no-console
  console[level === "success" ? "log" : level](`${prefix} →`, ...args);
}

export const logger = {
  info:    (tag: string, ...a: unknown[]) => log("info",    tag, ...a),
  warn:    (tag: string, ...a: unknown[]) => log("warn",    tag, ...a),
  error:   (tag: string, ...a: unknown[]) => log("error",   tag, ...a),
  debug:   (tag: string, ...a: unknown[]) => log("debug",   tag, ...a),
  success: (tag: string, ...a: unknown[]) => log("success", tag, ...a),
};
