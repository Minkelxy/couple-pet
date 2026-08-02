const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PetDomain, initialDb } = require("./domain");
const { FixedWindowRateLimiter, clientAddress } = require("./http-security");
const { createBackup, loadDatabase, saveDatabase } = require("./persistence");

const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || "127.0.0.1";
const dataFile = process.env.PET_DATA_FILE || path.join(process.cwd(), "data", "shared-pet.json");
const backupDir = process.env.PET_BACKUP_DIR || path.join(path.dirname(dataFile), "backups");
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
const audit = (action, fields = {}) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  level: "info",
  component: "shared-pet",
  action,
  ...fields
}));
let loaded;
try {
  loaded = loadDatabase(dataFile, backupDir, initialDb);
  if (loaded.recovered) saveDatabase(dataFile, loaded.db);
  audit("database.loaded", { source: loaded.source, recovered: loaded.recovered });
} catch {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    component: "shared-pet",
    action: "database.unavailable"
  }));
  process.exit(1);
}
const db = loaded.db;
const domain = new PetDomain(db);
const limiter = new FixedWindowRateLimiter();
let saveTimer;
const saveNow = () => {
  clearTimeout(saveTimer);
  saveDatabase(dataFile, db);
};
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 20); };
const backup = () => {
  if (!fs.existsSync(dataFile)) return;
  createBackup(dataFile, backupDir);
};
setInterval(backup, Number(process.env.PET_BACKUP_INTERVAL_MS || 21_600_000)).unref();

const json = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
};
const body = async (req) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) throw Object.assign(new Error("请求过大"), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
};
const auth = (req) => domain.authenticate((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/rooms") {
      limiter.assert(`rooms:${clientAddress(req)}`, 5, 15 * 60_000);
      const result = domain.createRoom(); save();
      audit("room.created", { roomId: result.roomId });
      return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/bind") {
      limiter.assert(`bind:${clientAddress(req)}`, 20, 15 * 60_000);
      const input = await body(req); const result = domain.bind(input.inviteCode, input.nickname);
      save();
      audit("device.bound", { roomId: result.roomId, deviceId: result.deviceId, userId: result.userId });
      return json(res, 201, result);
    }
    if (req.method === "GET" && url.pathname === "/snapshot") return json(res, 200, domain.snapshot(auth(req)));
    if (req.method === "GET" && url.pathname === "/events") {
      return json(res, 200, { events: domain.events(auth(req), url.searchParams.get("after")) });
    }
    if (req.method === "POST" && url.pathname === "/events") {
      const identity = auth(req);
      const result = domain.submit(identity, await body(req)); save();
      audit("event.accepted", { roomId: identity.roomId, deviceId: identity.deviceId, type: result.event.type, duplicate: result.duplicate });
      return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const identity = auth(req);
      domain.revoke(identity); save();
      audit("device.revoked", { roomId: identity.roomId, deviceId: identity.deviceId });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    if (error instanceof SyntaxError) error.status = 400;
    const status = error.status || 500;
    audit("request.rejected", { method: req.method, path: url.pathname, status });
    return json(
      res,
      status,
      { error: error.status ? error.message : "服务器内部错误" },
      error.retryAfterSec ? { "retry-after": String(error.retryAfterSec) } : {}
    );
  }
});

server.listen(port, host, () => {
  console.log(`Shared Pet server: http://${host}:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try { saveNow(); backup(); } catch (error) { console.error("Shutdown persistence failed:", error.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
