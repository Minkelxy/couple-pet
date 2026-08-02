const fs = require("node:fs");
const path = require("node:path");

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function isValidDatabase(db) {
  if (!isRecord(db) || !isRecord(db.rooms) || !isRecord(db.invites) || !isRecord(db.tokens)) return false;
  return Object.entries(db.rooms).every(([roomId, room]) => {
    if (!isRecord(room) || room.id !== roomId || typeof room.name !== "string" || typeof room.stage !== "string") return false;
    if (!Number.isFinite(room.growth) || !Number.isInteger(room.nextSeq) || room.nextSeq < 1) return false;
    if (!isRecord(room.stats) || !["mood", "energy", "fullness", "intimacy"].every((key) => Number.isFinite(room.stats[key]))) return false;
    if (!isRecord(room.users) || !isRecord(room.devices) || !Array.isArray(room.events) || !Array.isArray(room.gifts)) return false;
    return ["eventIds", "cooldowns", "dailyGrowth", "participation"].every((key) => isRecord(room[key]));
  });
}

function readDatabase(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isValidDatabase(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function backupFiles(backupDir) {
  try {
    return fs.readdirSync(backupDir)
      .filter((name) => /^shared-pet-.*\.json$/.test(name))
      .sort()
      .reverse()
      .map((name) => path.join(backupDir, name));
  } catch {
    return [];
  }
}

function loadDatabase(dataFile, backupDir, fallbackFactory) {
  const candidates = [
    { file: dataFile, source: "primary" },
    { file: `${dataFile}.previous`, source: "previous" },
    ...backupFiles(backupDir).map((file) => ({ file, source: "backup" }))
  ];
  let foundExisting = false;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;
    foundExisting = true;
    const db = readDatabase(candidate.file);
    if (db) return { db, source: candidate.source, recovered: candidate.source !== "primary" };
  }
  if (foundExisting) throw new Error("No valid shared-pet database snapshot is available.");
  const db = fallbackFactory();
  if (!isValidDatabase(db)) throw new Error("The initial shared-pet database is invalid.");
  return { db, source: "new", recovered: false };
}

function writeDurableTemp(file, data) {
  const descriptor = fs.openSync(file, "w");
  try {
    fs.writeFileSync(descriptor, data, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function saveDatabase(dataFile, db, io = fs) {
  if (!isValidDatabase(db)) throw new Error("Refusing to save an invalid shared-pet database.");
  io.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temp = `${dataFile}.tmp`;
  const previous = `${dataFile}.previous`;
  if (io === fs) writeDurableTemp(temp, `${JSON.stringify(db, null, 2)}\n`);
  else io.writeFileSync(temp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  try {
    io.renameSync(temp, dataFile);
    try { io.rmSync(previous, { force: true }); } catch {}
    return;
  } catch (error) {
    if (!io.existsSync(dataFile) || !["EEXIST", "EPERM"].includes(error.code)) {
      io.rmSync(temp, { force: true });
      throw error;
    }
  }
  try {
    io.rmSync(previous, { force: true });
    io.renameSync(dataFile, previous);
  } catch (error) {
    io.rmSync(temp, { force: true });
    throw error;
  }
  try {
    io.renameSync(temp, dataFile);
    try { io.rmSync(previous, { force: true }); } catch {}
  } catch (error) {
    try {
      if (!io.existsSync(dataFile) && io.existsSync(previous)) io.renameSync(previous, dataFile);
    } finally {
      io.rmSync(temp, { force: true });
    }
    throw error;
  }
}

function createBackup(dataFile, backupDir, now = new Date(), keep = 14) {
  const db = readDatabase(dataFile);
  if (!db) throw new Error("Refusing to back up an invalid shared-pet database.");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const target = path.join(backupDir, `shared-pet-${stamp}.json`);
  fs.copyFileSync(dataFile, target);
  for (const file of backupFiles(backupDir).slice(Math.max(1, keep))) fs.rmSync(file, { force: true });
  return target;
}

module.exports = { createBackup, isValidDatabase, loadDatabase, readDatabase, saveDatabase };
