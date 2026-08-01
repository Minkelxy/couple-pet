import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeQueue, normalizeUrl, register, POLL_ID } from "./index.js";

test("offline queue keeps valid events and stays bounded", () => {
  const input = Array.from({ length: 120 }, (_, index) => ({ id: `evt_${index}`, type: "CARE" }));
  const result = normalizeQueue([null, {}, ...input]);
  assert.equal(result.length, 100);
  assert.equal(result[0].id, "evt_20");
});

test("offline queue rejects malformed entries", () => {
  assert.deepEqual(normalizeQueue("bad"), []);
  assert.deepEqual(normalizeQueue([{ id: "x" }, { type: "CARE" }]), []);
});

test("server URL accepts HTTP(S) bases and rejects unsafe forms", () => {
  assert.equal(normalizeUrl("http://127.0.0.1:4317/"), "http://127.0.0.1:4317");
  assert.equal(normalizeUrl("https://shared-pet.example.com"), "https://shared-pet.example.com");
  assert.throws(() => normalizeUrl("shared-pet.example.com"), /地址无效/);
  assert.throws(() => normalizeUrl("https://user:pass@example.com"), /地址无效/);
  assert.throws(() => normalizeUrl("https://example.com?token=secret"), /地址无效/);
});

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  try {
    ({ createTestHarness } = await import(new URL("../../../vendor/openpets/packages/sdk/dist/testing.js", import.meta.url)));
  } catch {}
}

test("registers against the real OpenPets SDK v3 harness", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true }
  });
  await h.start();
  assert.ok(h.calls.commands.has("connect"));
  assert.ok(h.calls.commands.has("message"));
  assert.ok(h.calls.commands.has("gift"));
  assert.ok(h.calls.schedules.has(POLL_ID));
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);
  await h.emit("pet:clicked", {});
  assert.ok(h.calls.react.includes("waving"));
  assert.match(h.calls.speak.at(-1) || "", /插件设置/);
  assert.equal(h.calls.storage.has("offlineQueue"), false, "unpaired clicks must not enter the offline queue");
  assert.equal(h.calls.netCalls.length, 0, "unpaired clicks must not call the server");
  await assert.rejects(() => h.runCommand("message", { text: "hello" }), /连接共享房间/);
  assert.equal(h.calls.storage.has("offlineQueue"), false, "unpaired messages must not enter the offline queue");
  h.expectNoErrors();
  await h.stop();
});
