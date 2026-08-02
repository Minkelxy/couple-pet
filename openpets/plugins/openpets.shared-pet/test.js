import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CARE_COOLDOWN_MS,
  CARE_PRESENTATIONS,
  careCooldownRemaining,
  normalizeQueue,
  normalizeUrl,
  register,
  setupGuideText,
  sync,
  POLL_ID
} from "./index.js";

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

test("setup guide advances with nickname, invite, and connection state", () => {
  assert.match(setupGuideText({ nickname: "", inviteCode: "" }), /表单里填写昵称/);
  assert.match(setupGuideText({ nickname: "小雨", inviteCode: "" }), /第一台电脑.*邀请码留空/);
  assert.match(setupGuideText({ nickname: "小雨", inviteCode: "PET-ABCD" }), /已经填好.*加入/);
  assert.match(setupGuideText({}, true), /已经连接共享房间/);
});

test("care presentations are distinct and use the server's three-second cooldown", () => {
  assert.equal(CARE_COOLDOWN_MS, 3000);
  assert.equal(careCooldownRemaining(1000, 2500), 1500);
  assert.equal(careCooldownRemaining(1000, 4000), 0);
  assert.deepEqual(Object.keys(CARE_PRESENTATIONS), ["feed", "pet", "play", "rest"]);
  assert.equal(new Set(Object.values(CARE_PRESENTATIONS).map((item) => item.text)).size, 4);
  assert.ok(Object.values(CARE_PRESENTATIONS).every((item) => ["food", "heart", "sparkles", "moon"].includes(item.icon)));
  assert.equal(CARE_PRESENTATIONS.pet.reaction, "waving");
  assert.equal(CARE_PRESENTATIONS.rest.reaction, "waiting");
  assert.equal(CARE_PRESENTATIONS.feed.sprite, "feed");
  assert.equal(CARE_PRESENTATIONS.feed.fps, 5);
});

test("feed sprite uses the square strip contract required by the OpenPets override renderer", async () => {
  const manifest = JSON.parse(await readFile(new URL("./openpets.plugin.json", import.meta.url), "utf8"));
  const declaration = manifest.assets.sprites.feed;
  assert.equal(declaration.frameWidth, declaration.frameHeight);
  assert.equal(declaration.frames, 8);
  const bytes = await readFile(new URL(`./${declaration.path}`, import.meta.url));
  const chunk = bytes.indexOf(Buffer.from("VP8L"));
  assert.notEqual(chunk, -1, "feed sprite must be a lossless WebP");
  const dimensions = bytes.readUInt32LE(chunk + 9);
  const width = (dimensions & 0x3fff) + 1;
  const height = ((dimensions >>> 14) & 0x3fff) + 1;
  assert.equal(width, declaration.frameWidth * declaration.frames);
  assert.equal(height, declaration.frameHeight);
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
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
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
  assert.ok(h.calls.commands.has("disconnect"));
  const connectForm = h.calls.commands.get("connect")?.meta.form;
  assert.deepEqual(connectForm?.fields.map((field) => field.id), ["nickname", "inviteCode"]);
  assert.equal(connectForm?.fields[0]?.default, "小雨");
  assert.equal(connectForm?.fields[1]?.default, "");
  assert.ok(h.calls.commands.has("message"));
  assert.ok(h.calls.commands.has("gift"));
  assert.ok(h.calls.commands.has("guide"));
  assert.ok(h.calls.commands.has("diagnose"));
  assert.ok(h.calls.schedules.has(POLL_ID));
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);
  assert.ok(h.calls.bubbles.some((bubble) => bubble.spec.markdown?.includes("昵称")), "first start should explain setup in the pet UI");
  assert.equal(h.calls.storage.get("setupGuideSeen"), true);
  await h.emit("pet:clicked", {});
  assert.ok(h.calls.react.includes("waving"));
  assert.match(h.calls.speak.at(-1) || "", /创建 \/ 连接共享房间/);
  assert.equal(h.calls.storage.has("offlineQueue"), false, "unpaired clicks must not enter the offline queue");
  assert.equal(h.calls.netCalls.length, 0, "unpaired clicks must not call the server");
  await h.runCommand("message", { text: "hello" });
  assert.equal(h.calls.storage.has("offlineQueue"), false, "unpaired messages must not enter the offline queue");
  assert.ok(h.calls.bubbles.at(-1)?.spec.markdown?.includes("共享房间"), "unpaired commands should guide instead of failing");
  await h.runCommand("feed");
  assert.equal(h.calls.storage.has("offlineQueue"), false, "unpaired care must not enter the offline queue");
  h.net.mock("http://127.0.0.1:4317/health", { json: { ok: true } });
  await h.runCommand("diagnose");
  h.expectNetCall("/health");
  assert.match(h.calls.speak.at(-1) || "", /连接正常/);
  await h.setConfig({ serverUrl: "not-a-url", nickname: "小雨", inviteCode: "", showStats: true });
  await h.runCommand("diagnose");
  assert.match(h.calls.speak.at(-1) || "", /连接检查失败.*地址无效/);
  h.expectNoErrors();
  await h.stop();
});

test("disconnect requires confirmation, preserves recovery on failure, and clears a revoked session", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "", inviteCode: "", showStats: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");
  await h.ctx.storage.set("localProfile", { nickname: "小雨" });
  await h.ctx.storage.set("identity", { userId: "user-a", deviceId: "device-a" });
  await h.ctx.storage.set("partnerInvite", "PET-PARTNER");
  await h.ctx.storage.set("offlineQueue", [{ id: "queued_event", type: "CARE", payload: { action: "feed" } }]);
  await h.ctx.storage.set("snapshot", { roomId: "room-1" });
  await h.ctx.storage.set("eventCursor", 4);

  await h.runCommand("disconnect", { confirm: false });
  assert.equal(h.calls.secrets.get("deviceToken"), "token-a");
  assert.equal(h.calls.netCalls.length, 0);

  h.net.mock("http://127.0.0.1:4317/revoke", { status: 503, json: { error: "暂时不可用" } });
  await h.runCommand("disconnect", { confirm: true });
  assert.equal(h.calls.secrets.get("deviceToken"), "token-a", "failed revocation must keep the recoverable session");
  assert.equal(h.calls.storage.has("offlineQueue"), true);
  assert.match(h.calls.speak.at(-1) || "", /本机连接仍然保留/);

  h.net.mock("http://127.0.0.1:4317/revoke", { status: 200, json: { ok: true } });
  await h.runCommand("disconnect", { confirm: true });
  assert.equal(h.calls.secrets.has("deviceToken"), false);
  for (const key of ["identity", "partnerInvite", "offlineQueue", "snapshot", "eventCursor"]) {
    assert.equal(h.calls.storage.has(key), false, `${key} should be cleared after revocation`);
  }
  assert.deepEqual(h.calls.storage.get("localProfile"), { nickname: "小雨" }, "nickname remains available for the next pairing form");
  const revokeCalls = h.calls.netCalls.filter((call) => call.url.endsWith("/revoke"));
  assert.equal(revokeCalls.length, 2);
  assert.equal(revokeCalls.at(-1)?.headers?.authorization, "Bearer token-a");
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);
  assert.match(h.calls.speak.at(-1) || "", /已经安全断开/);
  h.expectNoErrors();
  await h.stop();
});

test("native connection form creates and binds a room without plugin settings", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "", inviteCode: "", showStats: true }
  });
  const state = {
    roomId: "room-1", name: "团团", stage: "初次相识", revision: 0,
    stats: { mood: 72, energy: 76, fullness: 70, intimacy: 0 }, users: [], gifts: []
  };
  h.net.mock("http://127.0.0.1:4317/rooms", {
    status: 201,
    json: { roomId: "room-1", inviteCodes: ["PET-FIRST", "PET-PARTNER"] }
  });
  h.net.mock("http://127.0.0.1:4317/bind", {
    status: 201,
    json: { token: "token-a", roomId: "room-1", deviceId: "device-a", userId: "user-a", state }
  });
  await h.start();
  await h.runCommand("connect", { nickname: "小雨", inviteCode: "" });
  assert.equal(h.calls.secrets.get("deviceToken"), "token-a");
  assert.deepEqual(h.calls.storage.get("localProfile"), { nickname: "小雨" });
  assert.equal(h.calls.storage.get("partnerInvite"), "PET-PARTNER");
  assert.equal(h.calls.netCalls.filter((call) => call.url.endsWith("/rooms")).length, 1);
  const bindCall = h.calls.netCalls.find((call) => call.url.endsWith("/bind"));
  assert.deepEqual(JSON.parse(bindCall?.body || "{}"), { inviteCode: "PET-FIRST", nickname: "小雨" });
  h.net.mock("http://127.0.0.1:4317/health", { json: { ok: true } });
  await h.runCommand("diagnose");
  assert.match(h.calls.speak.at(-1) || "", /共享房间都连接正常/);
  h.expectNoErrors();
  await h.stop();
});

test("offline recovery presents every partner message before advancing the cursor", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");
  await h.ctx.storage.set("identity", { userId: "user-a", deviceId: "device-a" });
  const state = {
    roomId: "room-1", name: "团团", stage: "初次相识", revision: 3,
    stats: { mood: 72, energy: 76, fullness: 70, intimacy: 4 }, users: [], gifts: []
  };
  h.net.mock("http://127.0.0.1:4317/snapshot", { json: state });
  h.net.mock("http://127.0.0.1:4317/events?after=0", { json: { events: [
    { seq: 1, type: "MESSAGE", actorId: "user-b", actorName: "阿岚", payload: { text: "第一条" } },
    { seq: 2, type: "MESSAGE", actorId: "user-b", actorName: "阿岚", payload: { text: "第二条" } },
    { seq: 3, type: "CARE", actorId: "user-a", actorName: "小雨", payload: { action: "pet" } }
  ] } });
  await h.emit("offline", {});
  assert.match(h.calls.status.at(-1)?.text || "", /离线/);
  assert.equal(h.calls.netCalls.length, 0, "offline notification must not make a doomed request");
  await h.emit("online", {});
  assert.ok(h.calls.bubbles.some((bubble) => bubble.spec.text?.includes("第一条") && bubble.spec.text?.includes("第二条")));
  assert.equal(h.calls.storage.get("eventCursor"), 3);
  h.expectNoErrors();
  await h.stop();
});

test("revoked token during queue flush returns to setup without stale follow-up requests", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "revoked-token");
  await h.ctx.storage.set("offlineQueue", [{
    id: "queued_event_401", type: "CARE", payload: { action: "pet" }, createdAt: Date.now()
  }]);
  h.net.mock("http://127.0.0.1:4317/events", { status: 401, json: { error: "设备令牌已撤销" } });
  await sync(h.ctx);
  assert.equal(h.calls.secrets.has("deviceToken"), false);
  assert.equal(h.calls.netCalls.filter((call) => call.url.endsWith("/events")).length, 1);
  assert.equal(h.calls.netCalls.some((call) => call.url.endsWith("/snapshot") || call.url.includes("/events?after=")), false);
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);
  assert.match(h.calls.speak.at(-1) || "", /绑定已失效/);
  h.expectNoErrors();
  await h.stop();
});

test("poll, online, and unlock sync triggers share one in-flight request", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");
  await h.ctx.storage.set("identity", { userId: "user-a", deviceId: "device-a" });
  const state = {
    roomId: "room-1", name: "团团", stage: "初次相识", revision: 1,
    stats: { mood: 72, energy: 76, fullness: 70, intimacy: 0 }, users: [], gifts: []
  };
  h.net.mock("http://127.0.0.1:4317/snapshot", { json: state });
  h.net.mock("http://127.0.0.1:4317/events?after=0", { json: { events: [
    { seq: 1, type: "MESSAGE", actorId: "user-b", actorName: "阿岚", payload: { text: "只显示一次" } }
  ] } });
  await Promise.all([sync(h.ctx), h.emit("online", {}), h.emit("screen:unlocked", {})]);
  assert.equal(h.calls.netCalls.filter((call) => call.url.endsWith("/snapshot")).length, 1);
  assert.equal(h.calls.netCalls.filter((call) => call.url.includes("/events?after=")).length, 1);
  assert.equal(h.calls.bubbles.filter((bubble) => bubble.spec.text?.includes("只显示一次")).length, 1);
  h.expectNoErrors();
  await h.stop();
});

test("care command applies local cooldown before a second server submission", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "pets:read", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");
  const state = {
    roomId: "room-1", name: "团团", stage: "初次相识", revision: 1,
    stats: { mood: 74, energy: 76, fullness: 86, intimacy: 0 }, users: [], gifts: []
  };
  h.net.mock("http://127.0.0.1:4317/events", {
    status: 201,
    json: { duplicate: false, event: { id: "event-feed", type: "CARE", payload: { action: "feed" } }, state }
  });
  await h.runCommand("feed");
  await h.runCommand("feed");
  assert.equal(h.calls.netCalls.filter((call) => call.url.endsWith("/events")).length, 1);
  assert.equal((await h.ctx.pet.getState()).currentAnimation, "sprite:feed");
  assert.ok(h.calls.schedules.has("shared-pet-care-animation-reset"));
  assert.match(h.calls.speak.at(-1) || "", /慢一点/);
  h.expectNoErrors();
  await h.stop();
});
