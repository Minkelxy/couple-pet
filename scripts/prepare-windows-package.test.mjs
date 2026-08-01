import assert from "node:assert/strict";
import test from "node:test";

import {
  patchBuiltInPetSource,
  patchPluginServiceSource,
  validateReleaseManifest,
} from "./prepare-windows-package.mjs";

function manifest(serverUrl = "https://pet.example.cn", hosts = ["127.0.0.1:4317", "pet.example.cn"]) {
  return {
    manifestVersion: 3,
    id: "openpets.shared-pet",
    runtime: "javascript",
    network: { hosts },
    configSchema: { serverUrl: { default: serverUrl } },
  };
}

test("production package accepts an HTTPS server present in the OpenPets allowlist", () => {
  assert.deepEqual(validateReleaseManifest(manifest()), {
    mode: "production",
    serverUrl: "https://pet.example.cn",
  });
});

test("production package rejects local, placeholder, and undeclared servers", () => {
  assert.throws(() => validateReleaseManifest(manifest("http://127.0.0.1:4317")), /HTTPS/);
  assert.throws(() => validateReleaseManifest(manifest("https://shared-pet.example.com", ["shared-pet.example.com"])), /示例域名/);
  assert.throws(() => validateReleaseManifest(manifest("https://other.example.cn")), /白名单/);
  assert.equal(validateReleaseManifest(manifest("http://127.0.0.1:4317"), { allowLocal: true }).mode, "local");
});

test("OpenPets overlay registers and enables the shared plugin idempotently", () => {
  const source = [
    'export const bundledOfficialPluginIds = ["openpets.reminders"] as const;',
    'const bundledEnabledByDefault = new Set<string>(["openpets.reminders"]);',
  ].join("\n");
  const once = patchPluginServiceSource(source);
  assert.match(once, /bundledOfficialPluginIds[^\n]+"openpets\.shared-pet"/);
  assert.match(once, /bundledEnabledByDefault[^\n]+"openpets\.shared-pet"/);
  assert.equal(patchPluginServiceSource(once), once);
});

test("OpenPets overlay renames only the known built-in pet contract", () => {
  assert.equal(
    patchBuiltInPetSource('export const builtInPet = { displayName: "Professor Hoot" };'),
    'export const builtInPet = { displayName: "团团" };',
  );
  assert.throws(() => patchBuiltInPetSource('displayName: "Unknown"'), /契约已变化/);
});
