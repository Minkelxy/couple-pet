import test from "node:test";
import assert from "node:assert/strict";

import { applyProductionDomain, normalizeDomain } from "./configure-production.mjs";

test("production domain validation rejects placeholders and URL-shaped input", () => {
  assert.equal(normalizeDomain("Pet.Minkelxy.cn."), "pet.minkelxy.cn");
  assert.throws(() => normalizeDomain("https://pet.minkelxy.cn"), /只填写域名/);
  assert.throws(() => normalizeDomain("localhost"), /完整的公网域名/);
  assert.throws(() => normalizeDomain("shared-pet.example.com"), /示例域名/);
  assert.throws(() => normalizeDomain("-bad.example.cn"), /格式无效/);
});

test("production configuration keeps local development and pins the HTTPS server", () => {
  const input = {
    network: { hosts: ["127.0.0.1:4317", "shared-pet.example.com"] },
    configSchema: { serverUrl: { type: "text", default: "http://127.0.0.1:4317" } }
  };
  const result = applyProductionDomain(input, "pet.minkelxy.cn");
  assert.deepEqual(result.manifest.network.hosts, ["127.0.0.1:4317", "pet.minkelxy.cn"]);
  assert.equal(result.manifest.configSchema.serverUrl.default, "https://pet.minkelxy.cn");
  assert.equal(input.configSchema.serverUrl.default, "http://127.0.0.1:4317", "input stays immutable");
});
