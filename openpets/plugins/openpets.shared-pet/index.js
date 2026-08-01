export const POLL_ID = "shared-pet-poll";
const QUEUE_KEY = "offlineQueue";
const CURSOR_KEY = "eventCursor";
const SNAPSHOT_KEY = "snapshot";
const IDENTITY_KEY = "identity";
const PARTNER_INVITE_KEY = "partnerInvite";
const TOKEN_KEY = "deviceToken";
const CARE_LABELS = { feed: "喂食", pet: "抚摸", play: "玩耍", rest: "休息" };
const GIFTS = ["毛线球", "小鱼干", "纸箱", "逗猫棒", "铃铛", "猫薄荷", "蝴蝶结", "软垫"];
const pinned = new WeakMap();
const running = new WeakSet();
const lastClickFeedback = new WeakMap();
const lastClickSubmit = new WeakMap();
const lastSetupHint = new WeakMap();

const eventId = () => `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
const parse = (response) => response.json ?? JSON.parse(response.text || "{}");

export function normalizeUrl(value) {
  const raw = String(value || "http://127.0.0.1:4317").trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error("同步服务地址无效，请填写完整的 http:// 或 https:// 地址。"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("同步服务地址无效，请填写不含账号、查询参数或片段的 HTTP(S) 地址。");
  }
  return raw.replace(/\/+$/, "");
}

export function normalizeQueue(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item.id === "string" && typeof item.type === "string").slice(-100)
    : [];
}

async function request(ctx, path, options = {}, token = null) {
  const cfg = await ctx.config.get();
  const url = `${normalizeUrl(cfg.serverUrl)}${path}`;
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await ctx.net.fetch(url, { timeoutMs: 8000, ...options, headers });
  const data = parse(response);
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

async function token(ctx) {
  try { return await ctx.secrets.get(TOKEN_KEY); } catch { return null; }
}

async function setStatus(ctx, kind, queueSize = 0) {
  try {
    await ctx.status.set({
      text: kind === "setup" ? "待配置 · 请先连接共享房间" : kind === "online" ? "已同步" : kind === "syncing" ? `同步中 · ${queueSize}` : `离线 · 待发送 ${queueSize}`,
      tone: kind === "online" ? "success" : kind === "syncing" ? "info" : "warning"
    });
  } catch {}
}

export async function updateHud(ctx, state) {
  const cfg = await ctx.config.get();
  if (!cfg.showStats || !state) {
    const handle = pinned.get(ctx);
    if (handle) { try { await handle.dismiss(); } catch {} }
    pinned.delete(ctx);
    return;
  }
  const spec = {
    sticky: true,
    pin: true,
    dismissOn: [],
    tone: "info",
    hud: {
      items: [
        { icon: "heart", value: state.stats.mood, tone: "pink", label: "心情" },
        { icon: "zap", value: state.stats.energy, tone: "blue", label: "体力" },
        { icon: "food", value: state.stats.fullness, tone: "amber", label: "饱食" },
        { icon: "sparkles", value: state.stats.intimacy, tone: "green", label: state.stage }
      ]
    }
  };
  const current = pinned.get(ctx);
  if (current) {
    try { await current.update(spec); return; } catch { pinned.delete(ctx); }
  }
  try {
    const handle = await ctx.ui.bubble(spec);
    handle.onDismiss(() => pinned.delete(ctx));
    pinned.set(ctx, handle);
  } catch {}
}

export async function connect(ctx) {
  const cfg = await ctx.config.get();
  const nickname = String(cfg.nickname || "").trim();
  if (!nickname) throw new Error("请先在插件设置中填写昵称。");
  let inviteCode = String(cfg.inviteCode || "").trim();
  let partnerCode = "";
  if (!inviteCode) {
    const room = await request(ctx, "/rooms", { method: "POST", body: "{}" });
    inviteCode = room.inviteCodes[0];
    partnerCode = room.inviteCodes[1];
  }
  const result = await request(ctx, "/bind", {
    method: "POST",
    body: JSON.stringify({ inviteCode, nickname })
  });
  await ctx.secrets.set(TOKEN_KEY, result.token);
  await ctx.storage.set(IDENTITY_KEY, { userId: result.userId, deviceId: result.deviceId });
  await ctx.storage.set(PARTNER_INVITE_KEY, partnerCode);
  await ctx.storage.set(QUEUE_KEY, []);
  await ctx.storage.set(SNAPSHOT_KEY, result.state);
  await ctx.storage.set(CURSOR_KEY, result.state.revision || 0);
  await updateHud(ctx, result.state);
  await setStatus(ctx, "online");
  await ctx.pet.react("celebrating", { showMessage: false });
  await ctx.pet.speak(partnerCode ? `创建成功！搭档邀请码：${partnerCode}` : "连接成功，我们一起照顾我吧！");
  return result;
}

export async function enqueue(ctx, type, payload) {
  if (!await token(ctx)) throw new Error("请先创建或连接共享房间，再进行这项操作。");
  const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
  queue.push({ id: eventId(), type, payload, createdAt: Date.now() });
  await ctx.storage.set(QUEUE_KEY, queue);
  return flush(ctx);
}

export async function flush(ctx) {
  const deviceToken = await token(ctx);
  if (!deviceToken) return null;
  const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
  await setStatus(ctx, queue.length ? "syncing" : "online", queue.length);
  while (queue.length) {
    try {
      const result = await request(ctx, "/events", {
        method: "POST",
        body: JSON.stringify(queue[0])
      }, deviceToken);
      queue.shift();
      await ctx.storage.set(QUEUE_KEY, queue);
      await ctx.storage.set(SNAPSHOT_KEY, result.state);
      await updateHud(ctx, result.state);
    } catch (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        queue.shift();
        await ctx.storage.set(QUEUE_KEY, queue);
        if (error.status === 401) {
          try { await ctx.secrets.delete(TOKEN_KEY); } catch {}
          await ctx.pet.speak("设备绑定已失效，请重新连接共享房间。");
          return null;
        }
        continue;
      }
      await setStatus(ctx, "offline", queue.length);
      return null;
    }
  }
  await setStatus(ctx, "online");
  return ctx.storage.get(SNAPSHOT_KEY);
}

export async function sync(ctx) {
  const deviceToken = await token(ctx);
  if (!deviceToken) return null;
  await flush(ctx);
  try {
    const cursor = Number(await ctx.storage.get(CURSOR_KEY) || 0);
    const [state, feed] = await Promise.all([
      request(ctx, "/snapshot", {}, deviceToken),
      request(ctx, `/events?after=${cursor}`, {}, deviceToken)
    ]);
    await ctx.storage.set(SNAPSHOT_KEY, state);
    await updateHud(ctx, state);
    const events = feed.events || [];
    if (events.length) {
      const identity = await ctx.storage.get(IDENTITY_KEY);
      const partnerEvents = events.filter((event) => event.actorId !== identity?.userId);
      await presentPartnerEvents(ctx, partnerEvents);
      await ctx.storage.set(CURSOR_KEY, Math.max(...events.map((event) => event.seq)));
    }
    await setStatus(ctx, "online");
    return state;
  } catch {
    const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
    await setStatus(ctx, "offline", queue.length);
    return null;
  }
}

async function presentPartnerEvents(ctx, events) {
  if (!events.length) return;
  const notices = [];
  for (const event of events) {
    if (event.type === "MESSAGE") notices.push(`${event.actorName}：${event.payload.text}`);
    else if (event.type === "GIFT") notices.push(`${event.actorName}送来了${event.payload.gift}！`);
  }
  if (notices.length) {
    const hasMessage = events.some((event) => event.type === "MESSAGE");
    await ctx.pet.react(hasMessage ? "waving" : "celebrating", { showMessage: false });
    await ctx.ui.bubble({ text: notices.join("\n"), sticky: notices.length > 1, tone: "info" });
    return;
  }
  const latestCare = events.filter((event) => event.type === "CARE").at(-1);
  if (latestCare) {
    await ctx.pet.react(latestCare.payload.action === "rest" ? "waiting" : "celebrating", { showMessage: false });
  }
}

async function care(ctx, action) {
  if (!await token(ctx)) throw new Error("请先创建或连接共享房间，再照顾团团。");
  await ctx.pet.react(action === "rest" ? "waiting" : action === "pet" ? "waving" : "celebrating", { showMessage: false });
  await ctx.pet.speak({ feed: "开饭啦！", pet: "呼噜呼噜～", play: "来追我呀！", rest: "我先眯一会儿…" }[action]);
  return enqueue(ctx, "CARE", { action });
}

async function handlePetClick(ctx, now = Date.now()) {
  const connected = Boolean(await token(ctx));
  if (now - (lastClickFeedback.get(ctx) || 0) >= 1000) {
    lastClickFeedback.set(ctx, now);
    await ctx.pet.react("waving", { showMessage: false });
  }
  if (!connected) {
    if (now - (lastSetupHint.get(ctx) || 0) >= 30_000) {
      lastSetupHint.set(ctx, now);
      await ctx.pet.speak("先在插件设置中填写昵称，再选择“创建 / 连接共享房间”吧。");
    }
    return null;
  }
  if (now - (lastClickSubmit.get(ctx) || 0) < 3000) return null;
  lastClickSubmit.set(ctx, now);
  await ctx.pet.speak("呼噜呼噜～");
  return enqueue(ctx, "CARE", { action: "pet" });
}

async function showInvite(ctx) {
  const code = await ctx.storage.get(PARTNER_INVITE_KEY);
  await ctx.pet.speak(code ? `搭档邀请码：${code}` : "这里没有待使用的邀请码，请在插件设置中填写搭档发来的邀请码。");
}

async function diagnose(ctx) {
  const cfg = await ctx.config.get();
  if (!String(cfg.nickname || "").trim()) {
    await setStatus(ctx, "setup");
    await ctx.pet.speak("还差一步：请先在插件设置中填写你的昵称。");
    return false;
  }
  try {
    const health = await request(ctx, "/health");
    if (health.ok !== true) throw new Error("服务未返回正常健康状态");
    const connected = Boolean(await token(ctx));
    await setStatus(ctx, connected ? "online" : "setup");
    await ctx.pet.react("success", { showMessage: false });
    await ctx.pet.speak(connected ? "同步服务和共享房间都连接正常！" : "同步服务连接正常，可以创建或加入共享房间啦！");
    return true;
  } catch (error) {
    await setStatus(ctx, "offline", normalizeQueue(await ctx.storage.get(QUEUE_KEY)).length);
    await ctx.pet.speak(`连接检查失败：${error instanceof Error ? error.message : "无法访问同步服务"}`);
    return false;
  }
}

async function showHistory(ctx) {
  const deviceToken = await token(ctx);
  if (!deviceToken) throw new Error("请先连接共享房间。");
  const cursor = Number(await ctx.storage.get(CURSOR_KEY) || 0);
  const feed = await request(ctx, `/events?after=${Math.max(0, cursor - 50)}`, {}, deviceToken);
  const lines = (feed.events || []).slice(-8).reverse().map((event) => {
    if (event.type === "CARE") return `${event.actorName} · ${CARE_LABELS[event.payload.action] || "照顾"}`;
    if (event.type === "MESSAGE") return `${event.actorName} · 传话`;
    if (event.type === "GIFT") return `${event.actorName} · 送来${event.payload.gift}`;
    return `${event.actorName} · ${event.type}`;
  });
  await ctx.ui.bubble({ text: lines.length ? lines.join("\n") : "还没有互动记录。", sticky: true, tone: "info" });
}

async function scheduleNextSync(ctx) {
  if (!running.has(ctx)) return;
  await ctx.schedule.once(POLL_ID, 15_000, async () => {
    try {
      await sync(ctx);
    } finally {
      if (running.has(ctx)) {
        try { await scheduleNextSync(ctx); } catch {}
      }
    }
  });
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      running.add(ctx);
      await ctx.commands.register({ id: "connect", title: "$t:command.connect", description: "$t:command.connectDescription", placement: "top", featured: true }, () => connect(ctx));
      for (const action of Object.keys(CARE_LABELS)) {
        await ctx.commands.register({ id: action, title: CARE_LABELS[action] }, () => care(ctx, action));
      }
      await ctx.commands.register({
        id: "message", title: "$t:command.message",
        form: { fields: [{ id: "text", type: "textarea", label: "$t:form.message", maxLength: 100, required: true }], submitLabel: "$t:form.send" }
      }, (values) => enqueue(ctx, "MESSAGE", { text: String(values?.text || "").slice(0, 100) }));
      await ctx.commands.register({
        id: "gift", title: "$t:command.gift",
        form: { fields: [{ id: "gift", type: "select", label: "$t:form.gift", required: true, options: GIFTS.map((gift) => ({ label: gift, value: gift })) }], submitLabel: "$t:form.send" }
      }, (values) => enqueue(ctx, "GIFT", { gift: String(values?.gift || "") }));
      await ctx.commands.register({ id: "history", title: "$t:command.history" }, () => showHistory(ctx));
      await ctx.commands.register({ id: "invite", title: "$t:command.invite" }, () => showInvite(ctx));
      await ctx.commands.register({ id: "diagnose", title: "$t:command.diagnose", description: "$t:command.diagnoseDescription" }, () => diagnose(ctx));
      try {
        ctx.events.on("pet:clicked", async () => {
          try { await handlePetClick(ctx); } catch {}
        });
      } catch {}
      const snapshot = await ctx.storage.get(SNAPSHOT_KEY);
      if (snapshot) await updateHud(ctx, snapshot);
      if (await token(ctx)) await sync(ctx);
      else await setStatus(ctx, "setup");
      await scheduleNextSync(ctx);
    },
    async stop(ctx) {
      running.delete(ctx);
      try { await ctx.schedule.cancel(POLL_ID); } catch {}
      const handle = pinned.get(ctx);
      if (handle) { try { await handle.dismiss(); } catch {} }
      pinned.delete(ctx);
    }
  });
}
