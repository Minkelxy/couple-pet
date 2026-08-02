const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const post = async (base, route, value, token) => {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(value)
  });
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
};

const get = async (base, route, token) => {
  const response = await fetch(`${base}${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return { status: response.status, body: await response.json() };
};

test("HTTP API completes pairing, offline recovery, idempotency and revocation", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-pet-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, PORT: String(port), PET_DATA_FILE: path.join(temp, "state.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let auditLog = "";
  child.stdout.on("data", (chunk) => { auditLog += String(chunk); });
  t.after(async () => {
    child.kill();
    await once(child, "exit");
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Shared Pet server")) { clearTimeout(timer); resolve(); }
    });
  });

  const room = await post(base, "/rooms", {});
  assert.equal(room.status, 201);
  const a = await post(base, "/bind", { inviteCode: room.body.inviteCodes[0], nickname: "小雨" });
  const b = await post(base, "/bind", { inviteCode: room.body.inviteCodes[1], nickname: "阿岚" });
  assert.equal(a.body.roomId, b.body.roomId);
  const reusedInvite = await post(base, "/bind", { inviteCode: room.body.inviteCodes[0], nickname: "重复设备" });
  assert.equal(reusedInvite.status, 400, "an invite code can only bind one device");

  const event = { id: "http_event_0001", type: "CARE", payload: { action: "pet" }, createdAt: Date.now() };
  const first = await post(base, "/events", event, a.body.token);
  const duplicate = await post(base, "/events", event, a.body.token);
  assert.equal(first.status, 201);
  assert.equal(duplicate.body.duplicate, true);

  // Device B is considered offline here: A can continue writing while B does
  // not poll. On recovery B receives the complete ordered delta once.
  const message = await post(base, "/events", {
    id: "http_message_0001",
    type: "MESSAGE",
    payload: { text: "今晚早点休息呀" },
    createdAt: Date.now()
  }, a.body.token);
  assert.equal(message.status, 201);

  const recovered = await get(base, "/events?after=0", b.body.token);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.events.map((item) => item.type), ["CARE", "MESSAGE"]);
  assert.equal(recovered.body.events[1].payload.text, "今晚早点休息呀");
  const cursor = recovered.body.events.at(-1).seq;
  const alreadyDisplayed = await get(base, `/events?after=${cursor}`, b.body.token);
  assert.deepEqual(alreadyDisplayed.body.events, [], "a recovered message is not returned after its cursor advances");

  const partnerCare = await post(base, "/events", {
    id: "http_event_0002",
    type: "CARE",
    payload: { action: "feed" },
    createdAt: Date.now()
  }, b.body.token);
  assert.equal(partnerCare.status, 201);
  assert.equal(partnerCare.body.state.growth, 12, "both participants receive the daily companion bonus");
  assert.equal(partnerCare.body.state.users.length, 2);

  const snapshotA = await get(base, "/snapshot", a.body.token);
  assert.equal(snapshotA.body.revision, 3);
  assert.deepEqual(snapshotA.body.stats, partnerCare.body.state.stats, "both devices converge on the same shared state");

  const revoked = await post(base, "/revoke", {}, b.body.token);
  assert.equal(revoked.status, 200);
  const afterRevoke = await get(base, "/snapshot", b.body.token);
  assert.equal(afterRevoke.status, 401, "a revoked device token loses access immediately");
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await post(base, "/rooms", {})).status, 201);
  }
  const rateLimited = await post(base, "/rooms", {});
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.retryAfter) > 0, "rate limit responses include Retry-After");
  assert.match(auditLog, /"action":"room.created"/);
  assert.match(auditLog, /"action":"event.accepted"/);
  assert.match(auditLog, /"action":"request.rejected"/);
  assert.doesNotMatch(auditLog, /今晚早点休息呀|小雨|阿岚/);
  assert.equal(auditLog.includes(a.body.token), false, "audit logs must not contain device tokens");
});
