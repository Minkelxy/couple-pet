const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PetDomain, initialDb } = require("./domain");

const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || "127.0.0.1";
const dataFile = process.env.PET_DATA_FILE || path.join(process.cwd(), "data", "shared-pet.json");
const backupDir = process.env.PET_BACKUP_DIR || path.join(path.dirname(dataFile), "backups");
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
let db = initialDb();
try { db = JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch {}
const domain = new PetDomain(db);
let saveTimer;
const saveNow = () => {
  clearTimeout(saveTimer);
  const temp = `${dataFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  try {
    fs.renameSync(temp, dataFile);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    fs.rmSync(dataFile, { force: true });
    fs.renameSync(temp, dataFile);
  }
};
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 20); };
const backup = () => {
  if (!fs.existsSync(dataFile)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  fs.copyFileSync(dataFile, path.join(backupDir, `shared-pet-${stamp}.json`));
  const files = fs.readdirSync(backupDir).filter((name) => /^shared-pet-.*\.json$/.test(name)).sort().reverse();
  for (const name of files.slice(14)) fs.rmSync(path.join(backupDir, name), { force: true });
};
setInterval(backup, Number(process.env.PET_BACKUP_INTERVAL_MS || 21_600_000)).unref();

const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS"
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
      const result = domain.createRoom(); save(); return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/bind") {
      const input = await body(req); const result = domain.bind(input.inviteCode, input.nickname);
      save(); return json(res, 201, result);
    }
    if (req.method === "GET" && url.pathname === "/snapshot") return json(res, 200, domain.snapshot(auth(req)));
    if (req.method === "GET" && url.pathname === "/events") {
      return json(res, 200, { events: domain.events(auth(req), url.searchParams.get("after")) });
    }
    if (req.method === "POST" && url.pathname === "/events") {
      const result = domain.submit(auth(req), await body(req)); save(); return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      domain.revoke(auth(req)); save(); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    if (error instanceof SyntaxError) error.status = 400;
    return json(res, error.status || 500, { error: error.status ? error.message : "服务器内部错误" });
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
