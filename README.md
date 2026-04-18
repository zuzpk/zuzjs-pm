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
zpm start ./dist/server.js --name api --watch

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
zpm restart-daemon

# Doctor (deep diagnostics)
zpm doctor
zpm doctor --json

# Namespace (optional but recommended for isolated environments)
zpm --namespace my-dev start pnpm --name app --arg="run start"
zpm --namespace my-dev stats app
zpm --namespace my-dev logs app
zpm --namespace my-dev kill-daemon

# Or set once per shell session
export ZPM_NAMESPACE=my-dev
zpm start pnpm --name app --arg="run start"
zpm stats app

# Logs
# Prints recent buffered logs first, then continues streaming live output.
zpm logs
zpm logs api
```

`zpm doctor` checks:

- Namespace wiring (`--namespace` / `ZPM_NAMESPACE`), socket path, PID file, and daemon reachability
- Local CLI hash vs global CLI hash
- npm registry metadata (`dist.shasum` + `dist.integrity`) vs your local `npm pack` artifact
- Working tree cleanliness (git dirty/clean)

`zpm doctor --json` emits the same diagnostics in machine-readable JSON for scripts/CI.

Note:

- Registry hash parity checks are strict only in a source checkout (git repo + src tree).
- When running from a globally installed package path, doctor skips local pack parity checks to avoid false mismatch noise.

### `zpm start` patterns

`zpm start <script>` accepts either:

- a JavaScript file path (runs with Node), or
- a non-JS executable/command (runs directly, with `--args` forwarded).

Examples:

```bash
# Examples
zpm start app.js
zpm start bashscript.sh
zpm start python-app.py --watch
zpm start binary-file -- --port 1520
zpm start app.py --interpreter python3
zpm start app.py --with python3
zpm start ./scripts/boot --interpreter bash
zpm start ./entry.noext --interpreter node
zpm start ./entry.any --interpreter custom --interpreter-command /usr/bin/env

# 1) Raw Node.js script (compiled output)
zpm start ./dist/server.js --name api --port 3000

# 2) Raw Node.js script with args
zpm start ./dist/worker.js --name worker --args "--queue emails --concurrency 4"

# 3) Next.js app via package manager
# Run from your Next.js project root.
zpm start pnpm --name "next-app" --arg="run start -p 3000"
zpm start npm  --name "next-app" --arg="run start -p 3000"

# Run from a different directory by setting cwd explicitly.
zpm start pnpm --name "next-app" --cwd ../my-web-app --arg="run start"
zpm start pnpm --name "next-app" --cwd /path/to/my-web-app --arg="run start"

# Or invoke next directly:
zpm start next --name "next-app" --arg="start -p 3000"

# 4) Next.js custom server entry
zpm start ./server.js --name web --port 3000

# 5) Rust binary (cargo build --release output)
zpm start ./target/release/my-rust-service --name rust-api --port 8080

# 5.1) Cargo project with multiple binaries
# Equivalent to: cargo run --bin service-node -- /path/to/service.config.json
zpm start cargo --name service-node --cwd /path/to/my-rust-project --arg="run --bin service-node -- /path/to/service.config.json"

# If omitting script in auto-detect mode, select cargo binary directly:
# Preferred (cleanest) form: pass app args after `--`
zpm start --cwd /path/to/my-rust-project --cargo-bin service-node -- /path/to/service.config.json

# Also accepted via --arg with cargo-style separator:
zpm start --cwd /path/to/my-rust-project --cargo-bin service-node --arg="-- /path/to/service.config.json"
# Equivalent direct-binary form (no cargo separator):
zpm start --cwd /path/to/my-rust-project --cargo-bin service-node --arg="/path/to/service.config.json"

# 6) Any custom executable/app
zpm start ./bin/custom-app --name custom --args "--env production --verbose"

# 7) Auto-detect mode (script omitted)
# If package.json has scripts.start, zpm runs the start script via your package manager.
zpm start --cwd /path/to/next-or-node-app

# If Python files are present (main.py/app.py/manage.py/server.py), zpm runs them.
zpm start --cwd /path/to/python-project

# If Cargo.toml exists, zpm prefers target/release|debug binary, else cargo run --release.
zpm start --cwd /path/to/rust-project
```

Notes:

- Use an absolute or relative path for built binaries (for example, Rust in `./target/release/...`).
- For app arguments, pass them after `--` or use `--arg/--args`.
- `--watch` is an alias for `--dev`.
- In auto-detect mode, if `package.json` start script contains `-p`/`--port`, zpm auto-detects it and frees that port before spawn.
- `--port` is used by zpm for pre-start port freeing and health intent; pass your app port (or let auto-detect infer it). If your binary binds 25050 internally, pass `--port 25050` so zpm can free conflicts before launch.
- `--interpreter` lets you force runtime selection: `auto`, `node`, `python3`, `bash`, or `custom` with `--interpreter-command`.
- `--with` is an alias for `--interpreter`.
- For custom binaries, ensure execute permission is set:

```bash
chmod +x ./target/release/my-app
```

Daemon notes:

- `zpm restart-daemon` performs a deep restart flow: resolves daemon PID from PID file or socket owner, stops it, cleans stale pid/socket artifacts, and starts a fresh daemon.
- If the daemon socket is owned by another user (for example root), restart may require `sudo` to terminate that process.
- `zpm doctor` now reports socket owner uid and hints when sudo may be required for daemon lifecycle operations.
- Daemon stdio is detached by default (so it does not keep writing logs into your terminal after `Ctrl+C`). For interactive daemon debugging only, set `ZPM_DAEMON_STDIO=inherit` before running a command.

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
