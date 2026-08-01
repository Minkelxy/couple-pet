import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const sharedPluginId = "openpets.shared-pet";

export function validateReleaseManifest(manifest, { allowLocal = false } = {}) {
  if (manifest?.manifestVersion !== 3 || manifest?.id !== sharedPluginId || manifest?.runtime !== "javascript") {
    throw new Error("共享插件必须是 openpets.shared-pet 的 OpenPets JavaScript v3 插件。");
  }

  const hosts = manifest.network?.hosts;
  const serverUrl = manifest.configSchema?.serverUrl?.default;
  if (!Array.isArray(hosts) || hosts.length === 0 || typeof serverUrl !== "string") {
    throw new Error("共享插件缺少网络白名单或默认服务地址。");
  }

  if (allowLocal) return { mode: "local", serverUrl };

  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("正式安装包的默认服务地址不是有效 URL。");
  }
  if (url.protocol !== "https:") throw new Error("正式安装包必须使用 HTTPS 默认服务地址。");
  if (hosts.some((host) => /(^|\.)example\.(com|net|org)(?::\d+)?$/i.test(host))) {
    throw new Error("正式安装包仍包含示例域名；请先运行 npm run configure:production -- <域名>。");
  }
  if (!hosts.includes(url.host)) throw new Error("默认服务地址未包含在 OpenPets 网络白名单中。");
  return { mode: "production", serverUrl };
}

export function patchPluginServiceSource(source) {
  let foundIds = false;
  let foundDefaults = false;
  let next = source.replace(
    /export const bundledOfficialPluginIds = \[([^\]]*)\] as const;/,
    (match, entries) => {
      foundIds = true;
      return entries.includes(`"${sharedPluginId}"`)
        ? match
        : `export const bundledOfficialPluginIds = [${appendEntry(entries, sharedPluginId)}] as const;`;
    },
  );
  next = next.replace(
    /const bundledEnabledByDefault = new Set<string>\(\[([^\]]*)\]\);/,
    (match, entries) => {
      foundDefaults = true;
      return entries.includes(`"${sharedPluginId}"`)
        ? match
        : `const bundledEnabledByDefault = new Set<string>([${appendEntry(entries, sharedPluginId)}]);`;
    },
  );
  if (!foundIds || !foundDefaults) throw new Error("OpenPets 插件初始化契约已变化，停止构建以避免生成缺少共享插件的安装包。");
  return next;
}

function appendEntry(entries, value) {
  const trimmed = entries.trimEnd();
  return `${trimmed}${trimmed.endsWith(",") ? " " : ", "}"${value}"`;
}

export function patchBuiltInPetSource(source) {
  if (!/displayName:\s*"(?:Professor Hoot|团团)"/.test(source)) {
    throw new Error("OpenPets 内置宠物契约已变化，无法安全替换为团团。");
  }
  return source.replace(/displayName:\s*"(?:Professor Hoot|团团)"/, 'displayName: "团团"');
}

export async function hashTree(root) {
  const hash = createHash("sha256");
  const files = await listFiles(root);
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output.sort((left, right) => left.localeCompare(right));
}

async function prepareWindowsPackage({ allowLocal }) {
  const vendorRoot = join(projectRoot, "vendor", "openpets");
  const desktopRoot = join(vendorRoot, "apps", "desktop");
  const sourcePlugin = join(projectRoot, "openpets", "plugins", sharedPluginId);
  const targetPlugin = join(vendorRoot, "plugins", "official", sharedPluginId);
  const sourceSprite = join(projectRoot, "openpets", "pets", "tuan-tuan", "spritesheet.webp");
  const targetSprite = join(desktopRoot, "assets", "default-pet-spritesheet.webp");
  const pluginServicePath = join(desktopRoot, "src", "plugin-service.ts");
  const builtInPetPath = join(desktopRoot, "src", "built-in-pet.ts");
  const manifestPath = join(sourcePlugin, "openpets.plugin.json");
  const upstreamPackagePath = join(vendorRoot, "package.json");

  const [manifest, upstreamPackage, pluginService, builtInPet] = await Promise.all([
    readJson(manifestPath),
    readJson(upstreamPackagePath),
    readFile(pluginServicePath, "utf8"),
    readFile(builtInPetPath, "utf8"),
  ]);
  if (upstreamPackage.name !== "openpets-v2-workspace" || !/^3\./.test(upstreamPackage.version ?? "")) {
    throw new Error("当前 vendor/openpets 不是已验证的 OpenPets 3.x 工作区。");
  }
  const release = validateReleaseManifest(manifest, { allowLocal });

  await rm(targetPlugin, { recursive: true, force: true });
  await cp(sourcePlugin, targetPlugin, { recursive: true });
  await cp(sourceSprite, targetSprite);
  await writeFile(pluginServicePath, patchPluginServiceSource(pluginService), "utf8");
  await writeFile(builtInPetPath, patchBuiltInPetSource(builtInPet), "utf8");

  const legalDir = join(desktopRoot, "assets", "legal");
  await mkdir(legalDir, { recursive: true });
  await cp(join(vendorRoot, "LICENSE"), join(legalDir, "OpenPets-LICENSE.txt"));
  await cp(join(projectRoot, "THIRD_PARTY_NOTICES.md"), join(legalDir, "THIRD_PARTY_NOTICES.md"));

  const [sourcePluginHash, targetPluginHash, spriteHash] = await Promise.all([
    hashTree(sourcePlugin),
    hashTree(targetPlugin),
    hashFile(sourceSprite),
  ]);
  if (sourcePluginHash !== targetPluginHash) throw new Error("共享插件复制后内容不一致。");
  const marker = {
    generatedAt: new Date().toISOString(),
    upstream: `OpenPets ${upstreamPackage.version}`,
    pet: "团团",
    plugin: `${sharedPluginId}@${manifest.version}`,
    mode: release.mode,
    serverUrl: release.serverUrl,
    sourcePluginSha256: sourcePluginHash,
    spriteSha256: spriteHash,
  };
  await writeFile(join(vendorRoot, ".couple-pet-overlay.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  process.stdout.write([
    `OpenPets Windows 覆盖层准备完成（${release.mode === "production" ? "生产" : "本地联调"}）`,
    `上游：OpenPets ${upstreamPackage.version}`,
    `内置宠物：团团`,
    `内置插件：${sharedPluginId}@${manifest.version}（首次启动默认启用）`,
    `默认服务：${release.serverUrl}`,
  ].join("\n") + "\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  prepareWindowsPackage({ allowLocal: process.argv.includes("--allow-local") }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
