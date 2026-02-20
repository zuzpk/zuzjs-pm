import { ChildProcess } from 'node:child_process';
import EventEmitter from 'node:events';

declare enum WorkerMode {
    Fork = "fork",// child_process.spawn – isolated scripts
    Cluster = "cluster"
}
declare enum WorkerStatus {
    Stopped = "stopped",
    Starting = "starting",
    Running = "running",
    Stopping = "stopping",
    Crashed = "crashed",
    Errored = "errored"
}
interface WorkerConfig {
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
}
interface LivenessProbeConfig {
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
interface WorkerStats {
    name: string;
    status: WorkerStatus;
    pid: number | null;
    uptime: number | null;
    restartCount: number;
    cpu: number | null;
    memoryRss: number | null;
    memoryHeap: number | null;
    mode: WorkerMode;
    instances: number;
}
type IPCCommand = {
    cmd: "start";
    name: string;
    config: WorkerConfig;
} | {
    cmd: "stop";
    name: string;
} | {
    cmd: "restart";
    name: string;
} | {
    cmd: "delete";
    name: string;
} | {
    cmd: "stats";
    name?: string;
} | {
    cmd: "list";
} | {
    cmd: "ping";
};
type IPCResponse = {
    ok: true;
    data: unknown;
} | {
    ok: false;
    error: string;
};
interface ManagedProcess {
    config: WorkerConfig;
    children: ChildProcess[];
    status: WorkerStatus;
    startTime: number | null;
    restartCount: number;
    backoffTime: number;
    restartTimer: NodeJS.Timeout | null;
    stabilityTimer: NodeJS.Timeout | null;
    probeTimer: NodeJS.Timeout | null;
    probeFailures: number;
    isRestarting: boolean;
}

/**
 * process-manager.ts
 * Top-level controller.  Owns a registry of Worker instances and
 * exposes the unified API used by both the IPC daemon and programmatic callers.
 */

declare class ProcessManager {
    private workers;
    start(config: WorkerConfig): Promise<void>;
    stop(name: string): Promise<void>;
    restart(name: string): Promise<void>;
    delete(name: string): Promise<void>;
    getStats(name?: string): Promise<WorkerStats[]>;
    list(): string[];
    stopAll(): Promise<void>;
    private require;
}

/**
 * worker.ts
 * Manages the full lifecycle of one application entry:
 *   – Fork mode  : child_process.spawn  (isolated scripts, daemons, etc.)
 *   – Cluster mode: node:cluster workers (load-balanced HTTP servers)
 */

declare class Worker {
    private readonly cfg;
    private readonly name;
    private watcher;
    constructor(config: WorkerConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    getStats(): Promise<WorkerStats>;
    private spawnAll;
    private forkChild;
    private onChildExit;
    private scheduleRestart;
    private startProbe;
    private stopProbe;
    private watchFiles;
    private stopWatcher;
    private initStore;
    private mp;
    private patch;
    private clearTimers;
}

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

declare class ZPMClient {
    private readonly daemonScript;
    constructor(daemonScript?: string);
    /** Returns true if daemon is reachable */
    isDaemonRunning(): Promise<boolean>;
    /** Spawn the daemon detached if it is not already running */
    ensureDaemon(): Promise<void>;
    /** Kill the daemon by PID */
    killDaemon(): Promise<void>;
    start(config: WorkerConfig): Promise<string>;
    stop(name: string): Promise<string>;
    restart(name: string): Promise<string>;
    delete(name: string): Promise<string>;
    stats(name?: string): Promise<WorkerStats[]>;
    list(): Promise<string[]>;
    private waitForDaemon;
}
declare const zpm: ZPMClient;

/**
 * ipc-server.ts
 * Unix-socket IPC server embedded inside daemon.ts.
 * Each message is a newline-delimited JSON string.
 */

declare function getSocketPath(): string;

declare const logger: {
    info: (tag: string, ...a: unknown[]) => void;
    warn: (tag: string, ...a: unknown[]) => void;
    error: (tag: string, ...a: unknown[]) => void;
    debug: (tag: string, ...a: unknown[]) => void;
    success: (tag: string, ...a: unknown[]) => void;
};

/**
 * probe.ts
 * Liveness probes: http | tcp | exec
 * Returns true if the target is alive, false otherwise.
 */

declare function runProbe(cfg: LivenessProbeConfig): Promise<boolean>;

/**
 * store.ts
 * Lightweight reactive store for process state.
 * Swap the internals for @zuzjs/store without touching the API.
 */

type StoreListener<T> = (key: string, value: T) => void;
declare class Store<T> extends EventEmitter {
    private map;
    set(key: string, value: T): void;
    get(key: string): T | undefined;
    has(key: string): boolean;
    delete(key: string): void;
    all(): Map<string, T>;
    onchange(listener: StoreListener<T>): this;
    offchange(listener: StoreListener<T>): this;
}
/** Singleton process store – one entry per managed worker name */
declare const processStore: Store<ManagedProcess>;

export { type IPCCommand, type IPCResponse, type LivenessProbeConfig, type ManagedProcess, ProcessManager, Worker, type WorkerConfig, WorkerMode, type WorkerStats, WorkerStatus, ZPMClient, getSocketPath, logger, processStore, runProbe, zpm };
