const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { initialDb } = require("./domain");
const { createBackup, isValidDatabase, loadDatabase, readDatabase, saveDatabase } = require("./persistence");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "shared-pet-persistence-"));
const roomDb = (name = "团团") => {
  const db = initialDb();
  db.rooms.room1 = {
    id: "room1", name, stage: "初次相识", growth: 0,
    stats: { mood: 72, energy: 76, fullness: 70, intimacy: 0 },
    users: {}, devices: {}, events: [], gifts: [], eventIds: {}, cooldowns: {}, dailyGrowth: {}, participation: {}, nextSeq: 1
  };
  return db;
};

test("database validation rejects structurally incomplete snapshots", () => {
  assert.equal(isValidDatabase(initialDb()), true);
  assert.equal(isValidDatabase({ rooms: {}, invites: {} }), false);
  assert.equal(isValidDatabase({ rooms: { room1: { id: "room1" } }, invites: {}, tokens: {} }), false);
});

test("loader recovers from previous file before older backups", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const backupDir = path.join(root, "backups");
  fs.writeFileSync(dataFile, "{broken", "utf8");
  fs.writeFileSync(`${dataFile}.previous`, JSON.stringify(roomDb("回滚团团")), "utf8");
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, "shared-pet-2026-01-01T00-00-00Z.json"), JSON.stringify(roomDb("备份团团")), "utf8");
  const loaded = loadDatabase(dataFile, backupDir, initialDb);
  assert.equal(loaded.source, "previous");
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.db.rooms.room1.name, "回滚团团");
});

test("loader skips corrupt recent backups and selects the newest valid snapshot", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const backupDir = path.join(root, "backups");
  fs.writeFileSync(dataFile, "null", "utf8");
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, "shared-pet-2026-01-02T00-00-00Z.json"), "{broken", "utf8");
  fs.writeFileSync(path.join(backupDir, "shared-pet-2026-01-01T00-00-00Z.json"), JSON.stringify(roomDb("有效备份")), "utf8");
  const loaded = loadDatabase(dataFile, backupDir, initialDb);
  assert.equal(loaded.source, "backup");
  assert.equal(loaded.db.rooms.room1.name, "有效备份");
});

test("loader refuses to replace existing corrupt data with an empty database", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  fs.writeFileSync(dataFile, "{broken", "utf8");
  assert.throws(() => loadDatabase(dataFile, path.join(root, "backups"), initialDb), /No valid shared-pet database/);
});

test("failed Windows-style replacement restores the original primary file", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const original = roomDb("原始状态");
  saveDatabase(dataFile, original);
  let renameCount = 0;
  const injected = {
    ...fs,
    renameSync(from, to) {
      renameCount += 1;
      if (renameCount === 1) throw Object.assign(new Error("occupied"), { code: "EEXIST" });
      if (renameCount === 3) throw Object.assign(new Error("replacement failed"), { code: "EIO" });
      return fs.renameSync(from, to);
    }
  };
  assert.throws(() => saveDatabase(dataFile, roomDb("新状态"), injected), /replacement failed/);
  assert.equal(readDatabase(dataFile).rooms.room1.name, "原始状态");
  assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
});

test("failed Windows-style rollback preparation leaves the primary untouched", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const original = roomDb("原始状态");
  saveDatabase(dataFile, original);
  let renameCount = 0;
  const injected = {
    ...fs,
    renameSync(from, to) {
      renameCount += 1;
      if (renameCount === 1) throw Object.assign(new Error("occupied"), { code: "EEXIST" });
      if (renameCount === 2) throw Object.assign(new Error("primary locked"), { code: "EPERM" });
      return fs.renameSync(from, to);
    }
  };
  assert.throws(() => saveDatabase(dataFile, roomDb("新状态"), injected), /primary locked/);
  assert.equal(readDatabase(dataFile).rooms.room1.name, "原始状态");
  assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
  assert.equal(fs.existsSync(`${dataFile}.previous`), false);
});

test("backups contain valid data and retain only the newest configured count", () => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const backupDir = path.join(root, "backups");
  saveDatabase(dataFile, roomDb());
  for (let index = 0; index < 5; index += 1) createBackup(dataFile, backupDir, new Date(Date.UTC(2026, 0, 1, 0, 0, index)), 3);
  const files = fs.readdirSync(backupDir).sort();
  assert.equal(files.length, 3);
  assert.match(files[0], /00-00-02Z/);
  assert.equal(isValidDatabase(JSON.parse(fs.readFileSync(path.join(backupDir, files[2]), "utf8"))), true);
});

test("server startup restores a corrupt primary from the newest valid backup", async (t) => {
  const root = tempDir();
  const dataFile = path.join(root, "state.json");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(backupDir);
  fs.writeFileSync(dataFile, "{broken", "utf8");
  fs.writeFileSync(path.join(backupDir, "shared-pet-2026-01-01T00-00-00Z.json"), JSON.stringify(roomDb("启动恢复")), "utf8");
  const port = 45000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, PORT: String(port), PET_DATA_FILE: dataFile, PET_BACKUP_DIR: backupDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await once(child, "exit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`recovery server start timeout: ${errors}`)), 5000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Shared Pet server")) { clearTimeout(timer); resolve(); }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.match(output, /"action":"database.loaded"/);
  assert.match(output, /"source":"backup"/);
  assert.match(output, /"recovered":true/);
  assert.equal(readDatabase(dataFile).rooms.room1.name, "启动恢复");
  assert.equal(errors, "");
});
