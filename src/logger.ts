import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import winston from "winston";

const LOG_DIR = path.join(os.homedir(), ".zpm", "logs");

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY/MM/DD HH:mm:ss" }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message, tag }) => {

      const t = pc.gray(`[${timestamp}]`);
      const label = pc.bold(`[ZPM/${(tag as string || "SYS").toUpperCase()}]`);

      return `${t} [${level == `info` ? 
          pc.cyan(level) 
          : level == `warn` ? pc.yellow(level) 
            : level == `error` ? pc.red(level)
              : level == `success` ? pc.green(level) 
                : level == `debug` ? pc.gray(level) 
                : `debug`}] ${label} → ${message}`;
    })
)

export const winstonLogger = winston.createLogger({
  levels: { error: 0, warn: 1, info: 2, success: 2, debug: 3 },
  transports: [
    new winston.transports.Console({
      level: "debug",
      format: logFormat,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "daemon.log"),
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    })
  ],
});

export const logger = {
  info:    (tag: string, ...a: any[]) => winstonLogger.info(a.join(" "), { tag }),
  warn:    (tag: string, ...a: any[]) => winstonLogger.warn(a.join(" "), { tag }),
  error:   (tag: string, ...a: any[]) => winstonLogger.error(a.join(" "), { tag }),
  debug:   (tag: string, ...a: any[]) => winstonLogger.debug(a.join(" "), { tag }),
  success: (tag: string, ...a: any[]) => winstonLogger.log("success" as any, a.join(" "), { tag }),
};