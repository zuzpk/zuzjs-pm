import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 
 * 1. Backup Package.json 
*/
const packageJsonPath = path.resolve(__dirname, "..", "core", "package.json");
const backupPath = path.resolve(__dirname, "..", "core", "package.json.bak");

/**Backup Package.json to backupPath */
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
fs.writeFileSync(backupPath, JSON.stringify(packageJson, null, 2))

delete packageJson.scripts
delete packageJson.devDependencies

const [ _major, _minor, _patch ] = packageJson.version.split(`.`)

let major = +_major
let minor = +_minor
let patch = +_patch

if ( patch < 99 ) {
    patch += 1
} else {
    patch = 0
    if ( minor < 99 ) {
        minor += 1
    } else {
        minor = 0
        major += 1
    }
}   

packageJson.version = `${major}.${minor}.${patch}`

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2))
