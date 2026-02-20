# @zuzjs/pm

A modular process manager built for the `@zuzjs` ecosystem.

---

## Architecture

```
src/
├── types.ts          – All shared types, enums, and interfaces
├── logger.ts         – Thin, colorized logger (swap for @zuzjs/core)
├── store.ts          – Reactive in-process state store (swap for @zuzjs/store)
├── probe.ts          – Liveness probes: http | tcp | exec
├── worker.ts         – Single-app lifecycle (Fork + Cluster modes)
├── process-manager.ts– Controller that owns all Worker instances
├── ipc-server.ts     – Unix socket / Named Pipe IPC server
├── daemon.ts         – Long-running background daemon entry point
├── client.ts         – Programmatic API + daemon spawner
├── cli.ts            – `zpm` CLI
└── index.ts          – Public barrel export
```

---

## Install

```bash
npm install @zuzjs/pm
```

---

## CLI Usage

```bash
# Start the daemon implicitly (auto-spawned on first command)
zpm start ./dist/server.js --name api --port 3000

# Cluster mode – one worker per CPU core
zpm start ./dist/server.js --name api --cluster --port 3000

# Dev mode – restart on file change
zpm start ./dist/server.js --name api --dev

# Inspect
zpm list
zpm stats
zpm stats api

# Control
zpm restart api
zpm stop    api
zpm delete  api

# Daemon
zpm kill-daemon
```

---

## Programmatic API

```ts
import { ZPMClient, WorkerMode } from "@zuzjs/pm";

const pm = new ZPMClient();

// Spawn daemon if not already running
await pm.ensureDaemon();

// Start a worker
await pm.start({
  name:       "api",
  scriptPath: "/abs/path/to/dist/server.js",
  port:       3000,
  mode:       WorkerMode.Fork,       // or WorkerMode.Cluster
  instances:  1,                     // ignored in Fork mode
  devMode:    false,
  env:        { LOG_LEVEL: "debug" },
  killTimeout: 5000,                 // ms before SIGKILL
  maxBackoff:  16000,                // ms backoff ceiling

  // Optional liveness probe
  probe: {
    type:             "http",
    target:           "http://localhost:3000/health",
    intervalSeconds:  10,
    timeoutSeconds:   5,
    failureThreshold: 3,
  },
});

// Telemetry
const stats = await pm.stats("api");
console.log(stats);
// [{ name, status, pid, uptime, restartCount, cpu, memoryRss, memoryHeap, mode, instances }]

// Control
await pm.restart("api");
await pm.stop("api");
await pm.delete("api");

// Kill the daemon itself
await pm.killDaemon();
```

---

## Embedding Without the Daemon

For tight integration (e.g., inside an existing long-running process):

```ts
import { ProcessManager, WorkerMode } from "@zuzjs/pm";

const manager = new ProcessManager();

await manager.start({
  name:       "worker",
  scriptPath: "./dist/worker.js",
  mode:       WorkerMode.Fork,
});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", async () => {
  await manager.stopAll();
  process.exit(0);
});
```

---

## Resiliency Features

| Feature | Details |
|---|---|
| **Exponential Backoff** | Starts at 1s, doubles on each crash, caps at 16s (configurable) |
| **Stability Reset** | After 5s of uptime, restart counter and backoff reset |
| **Immediate Crash Detection** | Crashes within 1.5s are treated as build errors – no retry until next file change |
| **Liveness Probes** | `http`, `tcp`, or `exec` – configurable interval, timeout, and failure threshold |
| **Graceful Shutdown** | `SIGTERM` → wait `killTimeout` ms → `SIGKILL` |
| **Dev Mode** | Chokidar watches the script's directory; restarts on `change`/`add` events |
| **Port Clearing** | Calls `fuser -k` to free a busy port before spawning |

---

## Build

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # tsc --watch
```
