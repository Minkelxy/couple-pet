import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CARE_COOLDOWN_MS,
  CARE_PRESENTATIONS,
  AMBIENT_MARKDOWN_LIMIT,
  careCooldownRemaining,
  normalizeQueue,
  normalizeUrl,
  partnerNoticePages,
  register,
  setupGuideText,
  sync,
  flush,
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

test("partner notices use bounded multiline markdown and screen unsafe content", () => {
  const events = Array.from({ length: 50 }, (_, index) => ({
    type: "MESSAGE",
    actorName: index === 0 ? "https://unsafe.example" : "阿岚",
    payload: { text: index === 1 ? "第一行\n第二行" : index === 2 ? "password: 123" : `第 ${index + 1} 条 ${"喵".repeat(80)}` }
  }));
  const pages = partnerNoticePages(events);
  assert.ok(pages.length > 1);
  assert.ok(pages.length <= 7, "one 50-event server page must fit within OpenPets's eight active-bubble quota alongside the HUD");
  assert.ok(pages.every((page) => page.length <= AMBIENT_MARKDOWN_LIMIT));
  assert.ok(pages.every((page) => !/https?:\/\/|password/i.test(page)));
  assert.match(pages.join("\n"), /搭档：/);
  assert.match(pages.join("\n"), /第一行 第二行/);
  assert.match(pages.join("\n"), /受桌面安全规则保护/);
});

test("feed sprite uses the square strip contract required by the OpenPets override renderer", async () => {
  const manifest = JSON.parse(await readFile(new URL("./openpets.plugin.json", import.meta.url), "utf8"));
  const declaration = manifest.assets.sprites.feed;
  assert.equal(declaration.frameWidth, declaration.frameHeight);
  assert.equal(declaration.frames, 8);
  assert.equal(declaration.durationMs, declaration.frames / CARE_PRESENTATIONS.feed.fps * 1000);
  assert.ok(CARE_PRESENTATIONS.feed.durationMs > declaration.durationMs, "the final frame must remain visible before returning to idle");
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

test("expected command failures stay inside the pet UI without host callback errors", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true, ambientBehavior: true }
  });
  await h.start();
  h.net.mock("http://127.0.0.1:4317/rooms", { status: 503, json: { error: "暂时不可用" } });
  await h.runCommand("connect", { nickname: "小雨", inviteCode: "" });
  assert.equal(h.calls.secrets.has("deviceToken"), false);
  assert.match(h.calls.speak.at(-1) || "", /暂时没有完成/);
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);

  await h.ctx.secrets.set("deviceToken", "token-a");
  await h.ctx.storage.set("identity", { userId: "user-a", deviceId: "device-a" });
  const callsBeforeReconnect = h.calls.netCalls.length;
  await h.runCommand("connect", { nickname: "小雨", inviteCode: "" });
  assert.equal(h.calls.netCalls.length, callsBeforeReconnect, "an active session must not be overwritten by accidental reconnect");
  assert.match(h.calls.speak.at(-1) || "", /先选择.*断开当前共享房间/);

  h.net.mock("http://127.0.0.1:4317/events?after=0", { status: 503, json: { error: "暂时不可用" } });
  await h.runCommand("history");
  assert.equal(h.calls.secrets.get("deviceToken"), "token-a", "transient history failure must preserve the session");
  assert.match(h.calls.speak.at(-1) || "", /暂时取不到互动记录/);

  h.net.mock("http://127.0.0.1:4317/events?after=0", { status: 401, json: { error: "设备令牌已撤销" } });
  await h.runCommand("history");
  assert.equal(h.calls.secrets.has("deviceToken"), false);
  assert.equal(h.calls.storage.has("identity"), false);
  assert.match(h.calls.status.at(-1)?.text || "", /待配置/);
  assert.match(h.calls.speak.at(-1) || "", /绑定已失效/);
  h.expectNoErrors();
  await h.stop();
});

test("message and gift commands report sent, queued, rejected, and invalid input states", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true, ambientBehavior: true }
  });
  const state = {
    roomId: "room-1", name: "团团", stage: "初次相识", revision: 1,
    stats: { mood: 72, energy: 76, fullness: 70, intimacy: 0 }, users: [], gifts: []
  };
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");

  h.net.mock("http://127.0.0.1:4317/events", { status: 201, json: { state } });
  await h.runCommand("message", { text: "  今天早点休息  " });
  assert.match(h.calls.speak.at(-1) || "", /传话送给搭档/);
  assert.deepEqual(h.calls.storage.get("offlineQueue"), []);
  const sentMessage = h.calls.netCalls.find((call) => call.url.endsWith("/events"));
  assert.equal(JSON.parse(sentMessage?.body || "{}").payload.text, "今天早点休息");

  h.net.mock("http://127.0.0.1:4317/events", { status: 503, json: { error: "暂时不可用" } });
  await h.runCommand("gift", { gift: "毛线球" });
  assert.match(h.calls.speak.at(-1) || "", /礼物已保存在待发送队列/);
  assert.equal(h.calls.storage.get("offlineQueue")?.length, 1);

  h.net.mock("http://127.0.0.1:4317/events", { status: 201, json: { state } });
  await flush(h.ctx);
  assert.deepEqual(h.calls.storage.get("offlineQueue"), []);

  const callsBeforeInvalidInput = h.calls.netCalls.length;
  await h.runCommand("message", { text: "   " });
  assert.match(h.calls.speak.at(-1) || "", /先写一句/);
  await h.runCommand("gift", { gift: "" });
  assert.match(h.calls.speak.at(-1) || "", /先选择一份/);
  assert.equal(h.calls.netCalls.length, callsBeforeInvalidInput);

  h.net.mock("http://127.0.0.1:4317/events", { status: 400, json: { error: "传话格式无效" } });
  await h.runCommand("message", { text: "会被服务拒绝" });
  assert.match(h.calls.speak.at(-1) || "", /传话没有被同步服务接受/);
  assert.equal(h.calls.speak.filter((text) => /有一项互动未被/.test(text)).length, 0, "user commands should receive one precise result bubble");
  assert.deepEqual(h.calls.storage.get("offlineQueue"), []);
  h.expectNoErrors();
  await h.stop();
});

test("quiet companionship reacts only with silent idle and lock animations", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "", inviteCode: "", showStats: true, ambientBehavior: true }
  });
  await h.start();
  const bubbleCount = h.calls.bubbles.length;
  const speechCount = h.calls.speak.length;
  await h.emit("idle:enter", { idleSeconds: 300 });
  assert.deepEqual(h.calls.reactions.at(-1), { reaction: "waiting", options: { showMessage: false } });
  assert.equal(h.calls.bubbles.length, bubbleCount, "ambient behavior must not open a bubble");
  assert.equal(h.calls.speak.length, speechCount, "ambient behavior must not speak");
  await h.emit("idle:exit", { idleSeconds: 301 });
  assert.equal(h.calls.react.at(-1), "idle");

  await h.setConfig({ serverUrl: "http://127.0.0.1:4317", nickname: "", inviteCode: "", showStats: true, ambientBehavior: false });
  const reactionsBeforeDisabledLock = h.calls.reactions.length;
  await h.emit("screen:locked", {});
  assert.equal(h.calls.reactions.length, reactionsBeforeDisabledLock, "disabled ambient behavior must stay inert");
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
  h.net.mock("http://127.0.0.1:4317/events?after=0", { json: { events: [
    { seq: 1, type: "CARE", actorId: "user-a", actorName: "小雨", payload: { action: "feed" } },
    { seq: 2, type: "MESSAGE", actorId: "user-b", actorName: "阿岚", payload: { text: "晚安" } }
  ] } });
  await h.runCommand("history");
  const history = h.calls.bubbles.at(-1)?.spec;
  assert.match(history?.markdown || "", /阿岚 · 传话/);
  assert.match(history?.markdown || "", /小雨 · 喂食/);
  assert.equal(history?.text, undefined, "multiline history must not use OpenPets's single-line text field");
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
  const recovered = h.calls.bubbles.find((bubble) => bubble.spec.markdown?.includes("第一条") && bubble.spec.markdown?.includes("第二条"));
  assert.ok(recovered, "recovered messages should use the OpenPets multiline markdown contract");
  assert.equal(recovered.spec.text, undefined);
  assert.deepEqual(recovered.spec.dismissOn, ["click", "petClick"]);
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

test("rate-limited queued care stays pending for automatic retry", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true, ambientBehavior: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "token-a");
  const queued = { id: "queued_rate_limited_care", type: "CARE", payload: { action: "feed" }, createdAt: Date.now() };
  await h.ctx.storage.set("offlineQueue", [queued]);
  h.net.mock("http://127.0.0.1:4317/events", { status: 429, json: { error: "慢一点" } });
  await flush(h.ctx);
  assert.deepEqual(h.calls.storage.get("offlineQueue"), [queued]);
  assert.match(h.calls.status.at(-1)?.text || "", /同步中/);
  assert.match(h.calls.speak.at(-1) || "", /已经保留.*自动重试/);
  assert.equal(h.calls.secrets.get("deviceToken"), "token-a");
  h.expectNoErrors();
  await h.stop();
});

test("revoked token during snapshot sync clears stale local session state", { skip: !createTestHarness }, async () => {
  const permissions = [
    "pet:speak", "pet:interact", "pet:pin", "pet:reaction", "pet:animate", "schedule", "storage",
    "secrets", "commands", "events", "network", "network:write", "network:local", "status"
  ];
  const en = JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8"));
  const h = createTestHarness(register, {
    permissions,
    locales: { en },
    config: { serverUrl: "http://127.0.0.1:4317", nickname: "小雨", inviteCode: "", showStats: true, ambientBehavior: true }
  });
  await h.start();
  await h.ctx.secrets.set("deviceToken", "revoked-token");
  await h.ctx.storage.set("identity", { userId: "user-a", deviceId: "device-a" });
  await h.ctx.storage.set("snapshot", { roomId: "room-old" });
  await h.ctx.storage.set("eventCursor", 9);
  h.net.mock("http://127.0.0.1:4317/snapshot", { status: 401, json: { error: "设备令牌已撤销" } });
  h.net.mock("http://127.0.0.1:4317/events?after=9", { json: { events: [] } });
  await sync(h.ctx);
  assert.equal(h.calls.secrets.has("deviceToken"), false);
  for (const key of ["identity", "snapshot", "eventCursor"]) assert.equal(h.calls.storage.has(key), false);
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
  assert.equal(h.calls.bubbles.filter((bubble) => bubble.spec.markdown?.includes("只显示一次")).length, 1);
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
