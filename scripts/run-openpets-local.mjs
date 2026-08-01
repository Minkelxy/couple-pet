import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openPetsRoot = join(projectRoot, "vendor", "openpets");
const desktopRoot = join(openPetsRoot, "apps", "desktop");
const electron = join(
  openPetsRoot,
  "node_modules",
  ".pnpm",
  "electron@42.0.0",
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const pluginPath = join(projectRoot, "openpets", "plugins", "openpets.shared-pet");
const dataRoot = join(projectRoot, "data");

if (!existsSync(electron)) {
  throw new Error(`Electron executable not found: ${electron}`);
}
if (!existsSync(join(pluginPath, "openpets.plugin.json"))) {
  throw new Error(`Shared Pet plugin not found: ${pluginPath}`);
}

mkdirSync(dataRoot, { recursive: true });
const stdout = openSync(join(dataRoot, "openpets.stdout.log"), "a");
const stderr = openSync(join(dataRoot, "openpets.stderr.log"), "a");

try {
  const marker = `\n--- OpenPets launch ${new Date().toISOString()} ---\n`;
  writeSync(stdout, marker);
  writeSync(stderr, marker);
  const child = spawn(electron, ["."], {
    cwd: desktopRoot,
    detached: true,
    windowsHide: false,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      OPENPETS_DEV: "1",
      OPENPETS_DISABLE_PLUGIN_CATALOG: "1",
      OPENPETS_DEV_PLUGIN_PATHS: pluginPath,
    },
  });
  child.unref();
  process.stdout.write(`OpenPets started (PID ${child.pid}). Logs: ${dataRoot}\n`);
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
