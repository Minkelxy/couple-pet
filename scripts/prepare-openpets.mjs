import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("openpets");
const targetRoot = resolve(process.argv[2] || "vendor/openpets");
await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, "plugins", "openpets.shared-pet"), resolve(targetRoot, "plugins", "dev", "openpets.shared-pet"), { recursive: true, force: true });
await cp(resolve(sourceRoot, "pets", "tuan-tuan"), resolve(targetRoot, "local-pets", "tuan-tuan"), { recursive: true, force: true });
console.log(`Prepared OpenPets overlay in ${targetRoot}`);
