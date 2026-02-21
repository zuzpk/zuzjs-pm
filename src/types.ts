import { ChildProcess } from "node:child_process";

export type dynamic = { 
    [x: string] : any 
}

export enum WorkerMode {
  Fork = "fork",       // child_process.spawn – isolated scripts
  Cluster = "cluster", // node:cluster – load-balanced web servers
}

export enum WorkerStatus {
  Stopped = "stopped",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
  Crashed = "crashed",
  Errored = "errored",
}

export interface WorkerConfig {
  /** Unique name / tag for this worker */
  name: string;
  /** Absolute path to the entry script */
  scriptPath: string;
  /** CLI arguments forwarded to the child */
  args?: string[];
  /** Extra environment variables merged on top of process.env */
  env?: Record<string, string>;
  /** Fork = spawn isolated child | Cluster = load-balanced workers */
  mode?: WorkerMode;
  /** Number of cluster workers (only used in Cluster mode) */
  instances?: number;
  /** Port the app listens on (used by port-free check) */
  port?: number;
  /** Dev mode – watch files and auto-restart on change */
  devMode?: boolean;
  /** Graceful shutdown timeout before SIGKILL (ms) */
  killTimeout?: number;
  /** Maximum exponential backoff ceiling (ms) */
  maxBackoff?: number;
  /** Liveness probe configuration */
  probe?: LivenessProbeConfig;
  /** Logs Setup */
  logs?: {
    /** Websocket Url to send logs 
     * e.g., "ws://localhost:4000/logs" */
    wsUrl?: string;
    /** Either to save logs to file or not */
    saveToFile?: boolean;
  },
  /** Command to run in dev mode on reload 
   * e.g., "npm run build" or "tsc && tsc-alias"
  */
  reloadCommand?: string;
}

export interface LivenessProbeConfig {
  /** "http" polls a URL | "tcp" opens a socket | "exec" runs a command */
  type: "http" | "tcp" | "exec";
  /** HTTP URL or TCP host:port or shell command */
  target: string;
  /** Seconds between probe attempts */
  intervalSeconds?: number;
  /** Seconds until a single probe is considered failed */
  timeoutSeconds?: number;
  /** Consecutive failures before marking the worker as crashed */
  failureThreshold?: number;
}

export interface WorkerStats {
  name: string;
  status: WorkerStatus;
  pid: number | null;
  uptime: number | null;      // ms since last start
  restartCount: number;
  cpu: number | null;         // percent (0-100)
  memoryRss: number | null;   // bytes
  memoryHeap: number | null;  // bytes (JS heap, if available)
  mode: WorkerMode;
  instances: number;
}

export type IPCCommand =
  | { cmd: "start";   name: string; config: WorkerConfig }
  | { cmd: "stop";    name: string }
  | { cmd: "restart"; name: string }
  | { cmd: "delete";  name: string }
  | { cmd: "stats";   name?: string }
  | { cmd: "list" }
  | { cmd: "ping" }
  | { cmd: "find-worker"; name: string }
  | { cmd: "add-worker"; autoStart: boolean, config: WorkerConfig }
  | { cmd: "logs"; name?: string }
  | { cmd: "get-store" };

export type IPCResponse =
  | { ok: true;  data: unknown }
  | { ok: false; error: string };

export type StoreInfo = ManagedProcess[] | null;
export interface ManagedProcess {
  config: WorkerConfig;
  children: ChildProcess[];        // length > 1 only in Cluster mode
  status: WorkerStatus;
  startTime: number | null;
  restartCount: number;
  backoffTime: number;
  restartTimer: NodeJS.Timeout | null;
  stabilityTimer: NodeJS.Timeout | null;
  probeTimer: NodeJS.Timeout | null;
  probeFailures: number;
  isRestarting: boolean;
  lastError?: string;
}