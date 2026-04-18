# @zuzjs/pm

Production-grade process manager for the @zuzjs ecosystem.

## Install

```bash
npm install @zuzjs/pm
```

## Quick Start

```bash
# Start a process (daemon auto-spawns on first command)
zpm start ./dist/server.js --name api --port 3000

# Inspect runtime
zpm list
zpm stats
zpm logs api

# Control lifecycle
zpm stop api
zpm restart api
zpm delete api
```

## CLI Commands

### Start

`zpm start [script]`

- JavaScript paths are run with Node.
- Non-JS executables/commands run directly.
- If `script` is omitted, zpm attempts auto-detect from `--cwd`.
- `zpm start <name>` resumes an existing worker by name when no override flags are given.

Common examples:

```bash
zpm start app.js
zpm start app.py --interpreter python3
zpm start ./entry.any --interpreter custom --interpreter-command /usr/bin/env
zpm start ./dist/server.js --name api --port 3000
zpm start ./dist/worker.js --name worker --args "--queue emails --concurrency 4"

# Next.js via package manager
zpm start pnpm --name next-app --arg="run start -p 3000"
zpm start pnpm --name next-app --cwd /path/to/my-web-app --arg="run start"

# Rust binary
zpm start ./target/release/my-rust-service --name rust-api --port 8080

# Cargo project with explicit binary
zpm start cargo --name service-node --cwd /path/to/my-rust-project --arg="run --bin service-node -- /path/to/service.config.json"

# Cargo auto-detect mode (preferred passthrough form)
zpm start --cwd /path/to/my-rust-project --cargo-bin service-node -- /path/to/service.config.json

# Auto-detect mode
zpm start --cwd /path/to/next-or-node-app
zpm start --cwd /path/to/python-project
zpm start --cwd /path/to/rust-project
```

Start notes:

- Use `--` or `--arg/--args` for app arguments.
- `--watch` is alias of `--dev`.
- `--with` is alias of `--interpreter`.
- `zpm` now preserves inherited `NODE_ENV` by default (instead of forcing production). In `--dev` mode it sets `NODE_ENV=development`.
- For custom binaries, ensure execute permission:

```bash
chmod +x ./target/release/my-app
```

### Inspect

```bash
zpm list
zpm list --compact
zpm list --wide
zpm list --json
zpm list --status running
zpm list --sort mem --order desc

zpm stats
zpm stats api
zpm stats --compact
zpm stats --wide
zpm stats --json
zpm stats --sort uptime --order desc
zpm stats --status errored

zpm store
zpm store --json
```

Output modes for `list` and `stats`:

- default: balanced table with key metadata
- `--compact`: fewer columns for narrow terminals
- `--wide`: expanded path/error columns for debugging
- `--json`: machine-readable output for CI/scripts

Query options for `list` and `stats`:

- `--status <status>`: `running`, `stopped`, `starting`, `stopping`, `crashed`, `errored`
- `--sort <field>`: `name`, `status`, `pid`, `cpu`, `mem`, `uptime`, `restarts`, `mode`, `cwd`, `script`
- `--order <order>`: `asc` or `desc`

### Control

```bash
zpm stop api
zpm restart api
zpm delete api
```

### Logs

```bash
zpm logs
zpm logs api
```

`zpm logs` replays recent buffered history first, then streams live output.

### Daemon

```bash
zpm start-daemon
zpm restart-daemon
zpm kill-daemon

# Explicit service provisioning (Linux + root)
zpm setup-service
zpm setup-service --restart-service
```

Daemon notes:

- `restart-daemon` performs deep restart (PID/socket resolution + stale cleanup + fresh start).
- If socket owner differs (for example root-owned socket), restart/kill may require `sudo`.
- `doctor` reports socket owner uid and sudo hints.
- Daemon stdio is detached by default; set `ZPM_DAEMON_STDIO=inherit` for interactive debugging.
- Daemon boot logs include runtime user context (root vs current user) for quick troubleshooting.
- When legacy snapshot recovery runs, a one-time migration audit log shows source and destination snapshot paths.

### Doctor

```bash
zpm doctor
zpm doctor --json
```

`doctor` checks:

- namespace wiring (`--namespace` / `ZPM_NAMESPACE`), socket, PID file, daemon reachability
- local CLI hash vs global CLI hash
- npm registry metadata (`dist.shasum` + `dist.integrity`) vs local `npm pack` artifact
- git working tree cleanliness

Doctor notes:

- Source-checkout mode performs strict publish parity checks.
- Global package locations skip local pack parity checks to avoid false mismatch noise.

### Namespace

Use a custom namespace to isolate environments:

```bash
zpm --namespace my-dev start pnpm --name app --arg="run start"
zpm --namespace my-dev stats app
zpm --namespace my-dev logs app
zpm --namespace my-dev kill-daemon

export ZPM_NAMESPACE=my-dev
zpm start pnpm --name app --arg="run start"
zpm stats app
```

Default namespace is `zuz-pm`.

## Linux Service Setup

On Linux global installs as root (`npm i -g @zuzjs/pm`), postinstall provisions and enables a `systemd` unit.

Service template:

```ini
[Unit]
Description=ZuzJS Process Manager Daemon
After=network.target

[Service]
Type=simple
User=<service-user>
Group=<service-group>
WorkingDirectory=/home/<service-user>/.zpm
ExecStart=/usr/bin/node /usr/lib/node_modules/@zuzjs/pm/dist/daemon.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=ZPM_NAMESPACE=zuz-pm
Environment=ZPM_STATE_DIR=/home/<service-user>/.zpm
Environment=PATH=/usr/bin:/usr/local/bin:/bin

[Install]
WantedBy=multi-user.target
```

Service notes:

- Actual `ExecStart` is generated dynamically from your active Node binary and install location.
- When provisioned via `sudo`, zpm prefers `SUDO_USER` as service user (for example `appuser`) instead of forcing root.
- Auto-setup is skipped on non-Linux, non-systemd, non-global, or non-root contexts.
- If npm global update did not provision the unit, run manually:

```bash
sudo node /usr/lib/node_modules/@zuzjs/pm/dist/postinstall.cjs
```

- `start-daemon` and `restart-daemon` (as root on Linux) run best-effort unit refresh without forced service restart.
- Use `zpm setup-service --restart-service` to provision and restart immediately.

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

## Build

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # tsc --watch
```
