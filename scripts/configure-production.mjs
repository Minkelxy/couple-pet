import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeDomain(input) {
  const domain = String(input || "").trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.includes("://") || /[\s/:?#@]/.test(domain)) {
    throw new Error("请只填写域名，例如 pet.example.cn，不要包含协议、端口或路径。");
  }
  if (domain.length > 253 || !domain.includes(".")) throw new Error("请输入完整的公网域名。");
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("域名格式无效。");
  }
  if (domain === "shared-pet.example.com" || /(^|\.)example\.(com|net|org)$/.test(domain)) {
    throw new Error("请替换示例域名后再配置生产环境。");
  }
  return domain;
}

export function applyProductionDomain(manifest, input) {
  const domain = normalizeDomain(input);
  if (!manifest?.network || !manifest?.configSchema?.serverUrl) throw new Error("插件清单缺少网络或服务地址配置。");
  const next = structuredClone(manifest);
  next.network.hosts = ["127.0.0.1:4317", domain];
  next.configSchema.serverUrl.default = `https://${domain}`;
  return { domain, manifest: next };
}

async function main() {
  const input = process.argv[2];
  const manifestPath = resolve(root, "openpets", "plugins", "openpets.shared-pet", "openpets.plugin.json");
  const envPath = resolve(root, "deploy", ".env");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const configured = applyProductionDomain(current, input);
  await writeFile(manifestPath, `${JSON.stringify(configured.manifest, null, 2)}\n`, "utf8");
  await writeFile(envPath, `PET_DOMAIN=${configured.domain}\n`, "utf8");
  process.stdout.write([
    `Production domain configured: ${configured.domain}`,
    `Plugin server URL: https://${configured.domain}`,
    `Deploy with: docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`,
    `Then verify: https://${configured.domain}/health`
  ].join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
