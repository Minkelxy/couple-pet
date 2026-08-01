import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashTree } from "./prepare-windows-package.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");

async function verifyWindowsPackage({ installer }) {
  const outputRoot = join(projectRoot, "vendor", "openpets", "apps", "desktop", "dist-electron");
  const sourcePlugin = join(projectRoot, "openpets", "plugins", "openpets.shared-pet");
  const packagedPlugin = join(outputRoot, "win-unpacked", "resources", "plugins", "official", "openpets.shared-pet");
  const manifest = JSON.parse(await readFile(join(packagedPlugin, "openpets.plugin.json"), "utf8"));
  if (manifest.id !== "openpets.shared-pet") throw new Error("安装包中的共享插件清单无效。");
  if (await hashTree(sourcePlugin) !== await hashTree(packagedPlugin)) {
    throw new Error("安装包中的共享插件与项目源文件不一致。");
  }

  const appAsar = join(outputRoot, "win-unpacked", "resources", "app.asar");
  if (!(await isNonEmptyFile(appAsar))) throw new Error("OpenPets app.asar 未生成或为空。");

  let installerName;
  if (installer) {
    installerName = (await readdir(outputRoot)).find((name) => /^OpenPets-.*-win-.*-setup\.exe$/i.test(name));
    if (!installerName || !(await isNonEmptyFile(join(outputRoot, installerName)))) {
      throw new Error("OpenPets Windows 安装程序未生成。");
    }
  }

  process.stdout.write([
    "OpenPets Windows 产物验证通过",
    `共享插件：openpets.shared-pet@${manifest.version}`,
    `解压目录：${join(outputRoot, "win-unpacked")}`,
    ...(installerName ? [`安装程序：${join(outputRoot, installerName)}`] : []),
  ].join("\n") + "\n");
}

async function isNonEmptyFile(path) {
  try {
    return (await stat(path)).isFile() && (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  verifyWindowsPackage({ installer: process.argv.includes("--installer") }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
