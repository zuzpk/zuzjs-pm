import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, "package.json")
const backupPath = path.join(__dirname, "package.json.bak")


if ( fs.existsSync(backupPath) ) {
    
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
    const packageJsonBackup = JSON.parse(fs.readFileSync(backupPath, "utf8"))
    
    packageJsonBackup.version = packageJson.version

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJsonBackup, null, 2))

    fs.unlinkSync(backupPath)
}