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
  return { status: response.status, body: await response.json() };
};

test("HTTP API completes the two-device idempotent care loop", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-pet-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, PORT: String(port), PET_DATA_FILE: path.join(temp, "state.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
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
  const event = { id: "http_event_0001", type: "CARE", payload: { action: "pet" }, createdAt: Date.now() };
  const first = await post(base, "/events", event, a.body.token);
  const duplicate = await post(base, "/events", event, a.body.token);
  assert.equal(first.status, 201);
  assert.equal(duplicate.body.duplicate, true);

  const feedResponse = await fetch(`${base}/events?after=0`, { headers: { authorization: `Bearer ${b.body.token}` } });
  const feed = await feedResponse.json();
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].payload.action, "pet");
});
