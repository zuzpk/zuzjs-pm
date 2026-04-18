import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isRootUser(): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid === 0;
}

function isGlobalInstallInvocation(): boolean {
  const npmGlobal = String(process.env.npm_config_global ?? "").toLowerCase();
  const npmLocation = String(process.env.npm_config_location ?? "").toLowerCase();
  const npmArgv = String(process.env.npm_config_argv ?? "").toLowerCase();
  const packageRoot = path.resolve(__dirname, "..");

  if (npmGlobal === "true" || npmGlobal === "1") return true;
  if (npmLocation === "global") return true;
  if (npmArgv.includes('"global":true')) return true;

  // Fallback for npm variants that do not pass global env flags reliably.
  return (
    packageRoot.startsWith("/usr/lib/node_modules/") ||
    packageRoot.startsWith("/usr/local/lib/node_modules/")
  );
}

function main(): void {
  if (process.platform !== "linux") {
    console.log("[zpm postinstall] Skip: non-linux platform.");
    return;
  }

  if (!isRootUser()) {
    console.log("[zpm postinstall] Skip: not running as root.");
    return;
  }

  if (!isGlobalInstallInvocation()) {
    console.log("[zpm postinstall] Skip: not a global install/update invocation.");
    return;
  }

  if (!hasCommand("systemctl")) {
    console.log("[zpm postinstall] Skip: systemctl not found.");
    return;
  }

  const daemonPath = path.resolve(__dirname, "daemon.cjs");
  if (!fs.existsSync(daemonPath)) {
    console.log("[zpm postinstall] Skip: daemon binary not found.");
    return;
  }

  const serviceName = "zpm.service";
  const servicePath = path.join("/etc/systemd/system", serviceName);
  const workingDirectory = "/var/lib/zpm";

  try {
    if (!fs.existsSync(workingDirectory)) {
      fs.mkdirSync(workingDirectory, { recursive: true });
    }

    const unit = `[Unit]\nDescription=ZuzJS Process Manager Daemon\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nWorkingDirectory=${workingDirectory}\nExecStart=${process.execPath} ${daemonPath}\nRestart=always\nRestartSec=5\nEnvironment=NODE_ENV=production\nEnvironment=ZPM_NAMESPACE=zuz-pm\nEnvironment=ZPM_STATE_DIR=/var/lib/zpm\nEnvironment=PATH=/usr/bin:/usr/local/bin:/bin\n\n[Install]\nWantedBy=multi-user.target\n`;

    fs.writeFileSync(servicePath, unit, "utf8");

    execSync("systemctl daemon-reload", { stdio: "ignore" });
    execSync(`systemctl enable ${serviceName}`, { stdio: "ignore" });

    if (process.env.ZPM_POSTINSTALL_NO_SERVICE_RESTART === "1") {
      console.log("[zpm postinstall] Installed/enabled systemd unit (service restart skipped).");
      return;
    }

    // Start or restart service to apply upgrades immediately.
    try {
      execSync(`systemctl restart ${serviceName}`, { stdio: "ignore" });
    } catch {
      execSync(`systemctl start ${serviceName}`, { stdio: "ignore" });
    }

    console.log("[zpm postinstall] Installed and enabled systemd service: zpm.service");
  } catch (err: any) {
    console.warn(`[zpm postinstall] Skipped service setup: ${err?.message ?? String(err)}`);
  }
}

main();
