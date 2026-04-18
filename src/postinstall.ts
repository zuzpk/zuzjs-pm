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

function isGlobalInstallRoot(): boolean {
  const npmGlobal = process.env.npm_config_global;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return npmGlobal === "true" && uid === 0;
}

function main(): void {
  if (process.platform !== "linux") return;
  if (!isGlobalInstallRoot()) return;
  if (!hasCommand("systemctl")) return;

  const daemonPath = path.resolve(__dirname, "daemon.cjs");
  if (!fs.existsSync(daemonPath)) return;

  const serviceName = "zpm.service";
  const servicePath = path.join("/etc/systemd/system", serviceName);
  const workingDirectory = "/var/lib/zpm";

  try {
    if (!fs.existsSync(workingDirectory)) {
      fs.mkdirSync(workingDirectory, { recursive: true });
    }

    const unit = `[Unit]\nDescription=ZuzJS Process Manager Daemon\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nWorkingDirectory=${workingDirectory}\nExecStart=${process.execPath} ${daemonPath}\nRestart=always\nRestartSec=5\nEnvironment=NODE_ENV=production\nEnvironment=ZPM_NAMESPACE=zuzjs-pm\nEnvironment=PATH=/usr/bin:/usr/local/bin:/bin\n\n[Install]\nWantedBy=multi-user.target\n`;

    fs.writeFileSync(servicePath, unit, "utf8");

    execSync("systemctl daemon-reload", { stdio: "ignore" });
    execSync(`systemctl enable ${serviceName}`, { stdio: "ignore" });

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
