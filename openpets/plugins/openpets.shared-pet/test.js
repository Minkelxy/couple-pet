import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeQueue, register, POLL_ID } from "./index.js";

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
  h.expectNoErrors();
  await h.stop();
});
