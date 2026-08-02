import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { patchPetPreloadSource } from "./prepare-windows-package.mjs";

const sourceRoot = resolve("openpets");
const targetRoot = resolve(process.argv[2] || "vendor/openpets");

await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, "pets", "tuan-tuan"), resolve(targetRoot, "local-pets", "tuan-tuan"), { recursive: true, force: true });
const petPreloadPath = join(targetRoot, "apps", "desktop", "pet-preload.cjs");
const petPreload = await readFile(petPreloadPath, "utf8");
await writeFile(petPreloadPath, patchPetPreloadSource(petPreload), "utf8");
console.log(`Prepared OpenPets pet assets and one-shot sprite timing in ${targetRoot}; the launcher loads the plugin directly from the project source.`);
