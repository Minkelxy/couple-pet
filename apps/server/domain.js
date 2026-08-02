const crypto = require("node:crypto");

const CARE = {
  feed: { fullness: 16, mood: 2, growth: 2, feedback: "吃得好香！" },
  pet: { mood: 14, intimacy: 4, growth: 2, feedback: "呼噜呼噜～" },
  play: { mood: 12, energy: -8, growth: 3, feedback: "再玩一次！" },
  rest: { energy: 18, growth: 1, feedback: "做个好梦…" }
};
const GIFTS = ["毛线球", "小鱼干", "纸箱", "逗猫棒", "铃铛", "猫薄荷", "蝴蝶结", "软垫"];
const STAGES = [
  [200, "共同回忆"],
  [100, "默契伙伴"],
  [40, "渐渐熟悉"],
  [0, "初次相识"]
];
const clamp = (n) => Math.max(0, Math.min(100, n));
const id = (bytes = 12) => crypto.randomBytes(bytes).toString("hex");
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function initialDb() {
  return { rooms: {}, invites: {}, tokens: {} };
}

function publicState(room) {
  return {
    roomId: room.id,
    name: room.name,
    stage: room.stage,
    stats: room.stats,
    growth: room.growth,
    users: Object.values(room.users).map(({ id, nickname }) => ({ id, nickname })),
    gifts: room.gifts.slice(-20),
    revision: room.nextSeq - 1
  };
}

class PetDomain {
  constructor(db = initialDb(), now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  createRoom() {
    const roomId = id();
    const codes = [`PET-${id(4).toUpperCase()}`, `PET-${id(4).toUpperCase()}`];
    this.db.rooms[roomId] = {
      id: roomId,
      name: "团团",
      stage: "初次相识",
      stats: { mood: 72, energy: 76, fullness: 70, intimacy: 0 },
      growth: 0,
      users: {},
      devices: {},
      events: [],
      eventIds: {},
      cooldowns: {},
      dailyGrowth: {},
      participation: {},
      gifts: [],
      nextSeq: 1
    };
    for (const code of codes) this.db.invites[code] = { roomId, used: false };
    return { roomId, inviteCodes: codes };
  }

  bind(inviteCode, nickname) {
    const invite = this.db.invites[String(inviteCode || "").trim().toUpperCase()];
    if (!invite || invite.used) throw Object.assign(new Error("邀请码无效或已使用"), { status: 400 });
    const room = this.db.rooms[invite.roomId];
    if (Object.keys(room.devices).length >= 2) throw Object.assign(new Error("房间已绑定两台设备"), { status: 409 });
    const userId = id(8);
    const deviceId = id(8);
    const token = id(24);
    room.users[userId] = { id: userId, nickname: String(nickname || "搭档").slice(0, 20) };
    room.devices[deviceId] = { id: deviceId, userId, tokenHash: tokenHash(token), revoked: false };
    this.db.tokens[tokenHash(token)] = { roomId: room.id, deviceId, userId };
    invite.used = true;
    return { token, roomId: room.id, deviceId, userId, state: publicState(room) };
  }

  authenticate(token) {
    const auth = this.db.tokens[tokenHash(token || "")];
    if (!auth) throw Object.assign(new Error("设备令牌无效"), { status: 401 });
    const room = this.db.rooms[auth.roomId];
    const device = room?.devices[auth.deviceId];
    if (!device || device.revoked) throw Object.assign(new Error("设备令牌已撤销"), { status: 401 });
    return { ...auth, room };
  }

  revoke(auth) {
    auth.room.devices[auth.deviceId].revoked = true;
    delete this.db.tokens[auth.room.devices[auth.deviceId].tokenHash];
  }

  snapshot(auth) {
    return publicState(auth.room);
  }

  events(auth, after = 0) {
    return auth.room.events.filter((event) => event.seq > Number(after || 0)).slice(0, 50);
  }

  submit(auth, input) {
    const room = auth.room;
    const eventId = String(input.id || "");
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(eventId)) {
      throw Object.assign(new Error("事件编号无效"), { status: 400 });
    }
    if (room.eventIds[eventId]) {
      return { duplicate: true, event: room.events.find((e) => e.id === eventId), state: publicState(room) };
    }
    const at = Math.min(Number(input.createdAt) || this.now(), this.now() + 60_000);
    const type = String(input.type || "").toUpperCase();
    const payload = input.payload || {};
    let detail;
    if (type === "CARE") detail = this.applyCare(room, auth, payload, at);
    else if (type === "MESSAGE") detail = this.applyMessage(payload);
    else if (type === "GIFT") detail = this.applyGift(room, payload);
    else if (type === "RENAME") detail = this.applyRename(room, payload);
    else throw Object.assign(new Error("不支持的事件类型"), { status: 400 });

    const event = {
      id: eventId,
      seq: room.nextSeq++,
      type,
      actorId: auth.userId,
      actorName: room.users[auth.userId].nickname,
      createdAt: at,
      acceptedAt: this.now(),
      payload: detail
    };
    room.eventIds[eventId] = true;
    room.events.push(event);
    if (room.events.length > 1000) room.events = room.events.slice(-1000);
    this.updateParticipation(room, auth.userId, at);
    room.stage = STAGES.find(([minimum]) => room.growth >= minimum)[1];
    return { duplicate: false, event, state: publicState(room) };
  }

  applyCare(room, auth, payload, at) {
    const action = String(payload.action || "");
    const rule = CARE[action];
    if (!rule) throw Object.assign(new Error("未知照顾操作"), { status: 400 });
    const cooldownKey = `${auth.deviceId}:${action}`;
    if ((room.cooldowns[cooldownKey] || 0) + 3000 > at) {
      throw Object.assign(new Error("慢一点，让它喘口气"), { status: 429 });
    }
    room.cooldowns[cooldownKey] = at;
    for (const key of ["mood", "energy", "fullness", "intimacy"]) {
      room.stats[key] = clamp(room.stats[key] + (rule[key] || 0));
    }
    const daily = `${auth.userId}:${dayKey(at)}`;
    const used = room.dailyGrowth[daily] || 0;
    const growth = Math.min(rule.growth, Math.max(0, 30 - used));
    room.dailyGrowth[daily] = used + growth;
    room.growth += growth;
    return { action, feedback: rule.feedback, growth };
  }

  applyMessage(payload) {
    const text = String(payload.text || "").trim();
    if (!text || text.length > 100) throw Object.assign(new Error("传话需为 1–100 个字符"), { status: 400 });
    return { text };
  }

  applyGift(room, payload) {
    const gift = String(payload.gift || "");
    if (!GIFTS.includes(gift)) throw Object.assign(new Error("未知礼物"), { status: 400 });
    room.gifts.push({ gift, receivedAt: this.now() });
    return { gift, feedback: `收到${gift}啦！` };
  }

  applyRename(room, payload) {
    const name = String(payload.name || "").trim().slice(0, 16);
    if (!name) throw Object.assign(new Error("名字不能为空"), { status: 400 });
    room.name = name;
    return { name };
  }

  updateParticipation(room, userId, at) {
    room.participation[userId] = at;
    const participants = Object.values(room.participation).filter((seen) => at - seen <= 86_400_000);
    const key = `bonus:${dayKey(at)}`;
    if (participants.length >= 2 && !room.dailyGrowth[key]) {
      room.dailyGrowth[key] = 8;
      room.growth += 8;
    }
  }
}

module.exports = { PetDomain, initialDb, publicState, CARE, GIFTS };
