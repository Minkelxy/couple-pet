import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("openpets");
const targetRoot = resolve(process.argv[2] || "vendor/openpets");

await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, "pets", "tuan-tuan"), resolve(targetRoot, "local-pets", "tuan-tuan"), { recursive: true, force: true });
console.log(`Prepared OpenPets pet assets in ${targetRoot}; the launcher loads the plugin directly from the project source.`);
