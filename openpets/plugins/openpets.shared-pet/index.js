export const POLL_ID = "shared-pet-poll";
const QUEUE_KEY = "offlineQueue";
const CURSOR_KEY = "eventCursor";
const SNAPSHOT_KEY = "snapshot";
const IDENTITY_KEY = "identity";
const PARTNER_INVITE_KEY = "partnerInvite";
const TOKEN_KEY = "deviceToken";
const SETUP_GUIDE_SEEN_KEY = "setupGuideSeen";
const PROFILE_KEY = "localProfile";
const CARE_ANIMATION_RESET_ID = "shared-pet-care-animation-reset";
export const CARE_COOLDOWN_MS = 3000;
export const AMBIENT_MARKDOWN_LIMIT = 900;
const CARE_LABELS = { feed: "喂食", pet: "抚摸", play: "玩耍", rest: "休息" };
export const CARE_PRESENTATIONS = {
  feed: { reaction: "success", sprite: "feed", fps: 5, durationMs: 1800, text: "开饭啦！", icon: "food", tone: "success" },
  pet: { reaction: "waving", text: "呼噜呼噜～", icon: "heart", tone: "info" },
  play: { reaction: "celebrating", text: "来追我呀！", icon: "sparkles", tone: "success" },
  rest: { reaction: "waiting", text: "我先眯一会儿…", icon: "moon", tone: "info" }
};
const GIFTS = ["毛线球", "小鱼干", "纸箱", "逗猫棒", "铃铛", "猫薄荷", "蝴蝶结", "软垫"];
const pinned = new WeakMap();
const running = new WeakSet();
const lastClickFeedback = new WeakMap();
const lastClickSubmit = new WeakMap();
const lastSetupHint = new WeakMap();
const lastCareSubmit = new WeakMap();
const syncInFlight = new WeakMap();
const presenceState = new WeakMap();
const careAnimationUntil = new WeakMap();

const eventId = () => `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
const parse = (response) => response.json ?? JSON.parse(response.text || "{}");
const unsafeAmbientPattern = /```|<script|function\s+\w+\s*\(|\b(?:import|export)\s|https?:\/\/|www\.|api[_-]?key|secret|password|BEGIN [A-Z ]+PRIVATE KEY/i;

function ambientPart(value, fallback) {
  const text = String(value || "").replace(/[\0-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return text && !unsafeAmbientPattern.test(text) ? text : fallback;
}

export function partnerNoticePages(events, limit = AMBIENT_MARKDOWN_LIMIT) {
  const lines = [];
  for (const event of Array.isArray(events) ? events : []) {
    const actor = ambientPart(event?.actorName, "搭档");
    if (event?.type === "MESSAGE") {
      lines.push(`${actor}：${ambientPart(event?.payload?.text, "发来一条受桌面安全规则保护的内容")}`);
    } else if (event?.type === "GIFT") {
      lines.push(`${actor}送来了${ambientPart(event?.payload?.gift, "一份礼物")}！`);
    }
  }
  const pages = [];
  let page = "";
  for (const line of lines) {
    const safeLine = line.slice(0, Math.max(1, limit));
    const next = page ? `${page}\n${safeLine}` : safeLine;
    if (page && next.length > limit) {
      pages.push(page);
      page = safeLine;
    } else {
      page = next;
    }
  }
  if (page) pages.push(page);
  return pages;
}

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

export function setupGuideText(config, connected = false) {
  if (connected) return "已经连接共享房间。右键团团，就可以照顾、传话和送礼物啦。";
  const nickname = String(config?.nickname || "").trim();
  const inviteCode = String(config?.inviteCode || "").trim();
  if (!nickname) {
    return "一起养团团只差一步：\n右键团团选择“创建 / 连接共享房间”，在弹出的表单里填写昵称；第一台电脑把搭档邀请码留空。";
  }
  if (inviteCode) return "昵称和搭档邀请码已经填好。右键团团，选择“创建 / 连接共享房间”即可加入。";
  return "昵称已经填好。第一台电脑把邀请码留空，右键团团选择“创建 / 连接共享房间”；创建后把团团说出的搭档邀请码发给对方。";
}

async function setupDefaults(ctx) {
  const [config, profile] = await Promise.all([
    ctx.config.get(),
    ctx.storage.get(PROFILE_KEY)
  ]);
  return {
    nickname: String(profile?.nickname || config.nickname || "").trim(),
    inviteCode: String(config.inviteCode || "").trim()
  };
}

export function careCooldownRemaining(lastAt, now = Date.now()) {
  return Math.max(0, CARE_COOLDOWN_MS - (now - Number(lastAt || 0)));
}

async function playCareAnimation(ctx, action) {
  const presentation = CARE_PRESENTATIONS[action];
  if (!presentation) return;
  careAnimationUntil.set(ctx, Date.now() + (presentation.durationMs || 3500));
  try { await ctx.schedule.cancel(CARE_ANIMATION_RESET_ID); } catch {}
  if (presentation.sprite) {
    try {
      await ctx.pet.setAnimation({
        sprite: ctx.assets.sprite(presentation.sprite),
        loop: false,
        fps: presentation.fps
      });
      await ctx.schedule.once(CARE_ANIMATION_RESET_ID, presentation.durationMs, async () => {
        careAnimationUntil.delete(ctx);
        try { await ctx.pet.setAnimation("idle"); } catch {}
      });
      return;
    } catch {
      try { await ctx.pet.setAnimation("idle"); } catch {}
    }
  }
  await ctx.pet.react(presentation.reaction, { showMessage: false });
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

function commandFailureText(action, error) {
  const status = Number(error?.status || 0);
  if (status === 429) return "操作有点频繁，稍等一会儿再试吧。";
  if (action === "connect" && [400, 404, 409].includes(status)) return "没有连接成功，请检查昵称和邀请码后再试。";
  if (action === "history") return "暂时取不到互动记录，团团会保留现有连接，请稍后再试。";
  if (action === "disconnect") return "暂时无法安全断开，本机连接和待发送内容都已保留。";
  return "这次操作暂时没有完成，团团已经保留可恢复的数据，请稍后再试。";
}

async function invalidateSession(ctx) {
  const hadToken = Boolean(await token(ctx));
  await clearLocalSession(ctx);
  if (hadToken) {
    try { await ctx.pet.speak("设备绑定已失效，请重新连接共享房间。"); } catch {}
  }
}

async function handleCommandFailure(ctx, action, error) {
  const status = Number(error?.status || 0);
  if (status === 401) {
    await invalidateSession(ctx);
  } else {
    const connected = Boolean(await token(ctx));
    await setStatus(ctx, connected ? "offline" : "setup", normalizeQueue(await ctx.storage.get(QUEUE_KEY)).length);
    try { await ctx.pet.speak({ text: commandFailureText(action, error), tone: "warning", durationMs: 5000 }); } catch {}
  }
  try {
    await ctx.log.warn("Shared pet command recovered without host failure.", {
      action,
      status,
      category: status ? "http" : "unavailable"
    });
  } catch {}
  return null;
}

function safeCommand(ctx, action, handler) {
  return async (values) => {
    try { return await handler(values); }
    catch (error) {
      try { return await handleCommandFailure(ctx, action, error); }
      catch { return null; }
    }
  };
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

export async function connect(ctx, values = {}) {
  if (await token(ctx)) {
    await ctx.pet.speak("这台电脑已经连接共享房间。如需更换，请先选择“断开当前共享房间”。");
    return null;
  }
  const defaults = await setupDefaults(ctx);
  const nickname = String(Object.hasOwn(values, "nickname") ? values.nickname : defaults.nickname).trim().slice(0, 20);
  if (!nickname) {
    await setStatus(ctx, "setup");
    await showSetupGuide(ctx);
    return null;
  }
  let inviteCode = String(Object.hasOwn(values, "inviteCode") ? values.inviteCode : defaults.inviteCode).trim().toUpperCase();
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
  await ctx.storage.set(PROFILE_KEY, { nickname });
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

async function clearLocalSession(ctx) {
  try { await ctx.secrets.delete(TOKEN_KEY); } catch {}
  await Promise.allSettled([
    ctx.storage.delete(IDENTITY_KEY),
    ctx.storage.delete(PARTNER_INVITE_KEY),
    ctx.storage.delete(QUEUE_KEY),
    ctx.storage.delete(SNAPSHOT_KEY),
    ctx.storage.delete(CURSOR_KEY)
  ]);
  lastCareSubmit.delete(ctx);
  lastClickSubmit.delete(ctx);
  careAnimationUntil.delete(ctx);
  try { await ctx.schedule.cancel(CARE_ANIMATION_RESET_ID); } catch {}
  try { await ctx.pet.setAnimation("idle"); } catch {}
  await updateHud(ctx, null);
  await setStatus(ctx, "setup");
}

export async function disconnect(ctx, values = {}) {
  if (values.confirm !== true) {
    await ctx.pet.speak("没有执行断开。请勾选确认后再提交。");
    return false;
  }
  const deviceToken = await token(ctx);
  if (!deviceToken) {
    await setStatus(ctx, "setup");
    await ctx.pet.speak("这台电脑当前没有连接共享房间。");
    return true;
  }
  try {
    await request(ctx, "/revoke", { method: "POST", body: "{}" }, deviceToken);
  } catch (error) {
    if (error?.status !== 401) {
      await setStatus(ctx, "offline", normalizeQueue(await ctx.storage.get(QUEUE_KEY)).length);
      await ctx.pet.speak(`断开失败：${error instanceof Error ? error.message : "无法访问同步服务"}。本机连接仍然保留。`);
      return false;
    }
  }
  await clearLocalSession(ctx);
  await ctx.pet.speak("已经安全断开这台电脑。需要时可重新创建或加入共享房间。");
  return true;
}

export async function enqueue(ctx, type, payload) {
  if (!await token(ctx)) {
    await setStatus(ctx, "setup");
    await showSetupGuide(ctx);
    return null;
  }
  const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
  const event = { id: eventId(), type, payload, createdAt: Date.now() };
  queue.push(event);
  await ctx.storage.set(QUEUE_KEY, queue);
  const outcome = await flush(ctx, { notifyQueue: type === "CARE" });
  const pending = normalizeQueue(await ctx.storage.get(QUEUE_KEY)).some((item) => item.id === event.id);
  return {
    id: event.id,
    pending,
    rejected: Boolean(outcome?.rejectedIds?.includes(event.id)),
    sessionInvalid: outcome?.sessionInvalid === true,
    state: outcome?.state || null
  };
}

export async function flush(ctx, options = {}) {
  const deviceToken = await token(ctx);
  if (!deviceToken) return null;
  const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
  const rejectedIds = [];
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
        if (error.status === 401) {
          await invalidateSession(ctx);
          return { state: null, rejectedIds, sessionInvalid: true };
        }
        if (error.status === 429) {
          await setStatus(ctx, "syncing", queue.length);
          if (options.notifyQueue !== false) {
            try { await ctx.pet.speak("操作有点频繁，这项互动已经保留，稍后会自动重试。"); } catch {}
          }
          return { state: null, rejectedIds, retryPending: true };
        }
        rejectedIds.push(queue[0].id);
        queue.shift();
        await ctx.storage.set(QUEUE_KEY, queue);
        if (options.notifyQueue !== false) {
          try { await ctx.pet.speak("有一项互动未被同步服务接受，已跳过并继续发送后续内容。"); } catch {}
        }
        continue;
      }
      await setStatus(ctx, "offline", queue.length);
      return { state: null, rejectedIds, retryPending: true };
    }
  }
  await setStatus(ctx, "online");
  return { state: await ctx.storage.get(SNAPSHOT_KEY), rejectedIds };
}

async function acknowledgeDelivery(ctx, kind, delivery) {
  if (!delivery || delivery.sessionInvalid) return delivery;
  const labels = kind === "message"
    ? { sent: "团团已经把传话送给搭档啦！", pending: "网络暂时不可用，传话已保存在待发送队列。", rejected: "这条传话没有被同步服务接受，请修改后再试。" }
    : { sent: "团团已经把礼物送给搭档啦！", pending: "网络暂时不可用，礼物已保存在待发送队列。", rejected: "这份礼物没有被同步服务接受，请重新选择。" };
  const text = delivery.rejected ? labels.rejected : delivery.pending ? labels.pending : labels.sent;
  const tone = delivery.rejected || delivery.pending ? "warning" : "success";
  try { await ctx.pet.speak({ text, tone, durationMs: 4500 }); } catch {}
  return delivery;
}

async function sendMessage(ctx, values = {}) {
  const text = String(values.text || "").trim().slice(0, 100);
  if (!text) {
    await ctx.pet.speak("先写一句想让团团带给搭档的话吧。");
    return null;
  }
  return acknowledgeDelivery(ctx, "message", await enqueue(ctx, "MESSAGE", { text }));
}

async function sendGift(ctx, values = {}) {
  const gift = String(values.gift || "");
  if (!GIFTS.includes(gift)) {
    await ctx.pet.speak("请先选择一份要送给搭档的小礼物。");
    return null;
  }
  return acknowledgeDelivery(ctx, "gift", await enqueue(ctx, "GIFT", { gift }));
}

export function sync(ctx) {
  const active = syncInFlight.get(ctx);
  if (active) return active;
  const current = performSync(ctx).finally(() => {
    if (syncInFlight.get(ctx) === current) syncInFlight.delete(ctx);
  });
  syncInFlight.set(ctx, current);
  return current;
}

async function performSync(ctx) {
  const deviceToken = await token(ctx);
  if (!deviceToken) return null;
  await flush(ctx);
  if (!await token(ctx)) {
    await setStatus(ctx, "setup");
    return null;
  }
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
  } catch (error) {
    if (error?.status === 401) {
      await invalidateSession(ctx);
      return null;
    }
    const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
    await setStatus(ctx, "offline", queue.length);
    return null;
  }
}

async function handleOffline(ctx) {
  if (!await token(ctx)) {
    await setStatus(ctx, "setup");
    return;
  }
  const queue = normalizeQueue(await ctx.storage.get(QUEUE_KEY));
  await setStatus(ctx, "offline", queue.length);
}

async function handleRecovery(ctx) {
  if (!await token(ctx)) {
    await setStatus(ctx, "setup");
    return null;
  }
  return sync(ctx);
}

async function handlePresence(ctx, event) {
  const current = presenceState.get(ctx) || { idle: false, locked: false };
  const next = {
    idle: event === "idle:enter" ? true : event === "idle:exit" ? false : current.idle,
    locked: event === "screen:locked" ? true : event === "screen:unlocked" ? false : current.locked
  };
  presenceState.set(ctx, next);
  const config = await ctx.config.get();
  if (config.ambientBehavior === false || Date.now() < (careAnimationUntil.get(ctx) || 0)) return;
  if (next.locked || next.idle) {
    await ctx.pet.react("waiting", { showMessage: false });
    return;
  }
  if (event === "idle:exit" || event === "screen:unlocked") await ctx.pet.setAnimation("idle");
}

async function presentPartnerEvents(ctx, events) {
  if (!events.length) return;
  const pages = partnerNoticePages(events);
  if (pages.length) {
    const hasMessage = events.some((event) => event.type === "MESSAGE");
    await ctx.pet.react(hasMessage ? "waving" : "celebrating", { showMessage: false });
    for (const markdown of pages) {
      await ctx.ui.bubble({ markdown, sticky: true, tone: "info", dismissOn: ["click", "petClick"] });
    }
    return;
  }
  const latestCare = events.filter((event) => event.type === "CARE").at(-1);
  if (latestCare) {
    await playCareAnimation(ctx, latestCare.payload.action);
  }
}

async function care(ctx, action, now = Date.now()) {
  if (!await token(ctx)) {
    await setStatus(ctx, "setup");
    await showSetupGuide(ctx);
    return null;
  }
  const submitted = lastCareSubmit.get(ctx) || {};
  const remaining = careCooldownRemaining(submitted[action], now);
  if (remaining > 0) {
    try { await ctx.pet.speak({ text: "慢一点，让团团喘口气～", tone: "info", durationMs: Math.min(remaining, 3000) }); } catch {}
    return null;
  }
  lastCareSubmit.set(ctx, { ...submitted, [action]: now });
  const presentation = CARE_PRESENTATIONS[action];
  try {
    await playCareAnimation(ctx, action);
    await ctx.pet.speak({ text: presentation.text, icon: presentation.icon, tone: presentation.tone, durationMs: 3500 });
  } catch {
    try { await ctx.log.warn("Care feedback unavailable.", { action }); } catch {}
  }
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
      await ctx.pet.speak("右键选择“创建 / 连接共享房间”，填写昵称就能开始啦。");
    }
    return null;
  }
  if (now - (lastClickSubmit.get(ctx) || 0) < 3000) return null;
  lastClickSubmit.set(ctx, now);
  return care(ctx, "pet", now);
}

async function showSetupGuide(ctx, automatic = false) {
  const defaults = await setupDefaults(ctx);
  const connected = Boolean(await token(ctx));
  const text = setupGuideText(defaults, connected);
  await ctx.ui.bubble({
    markdown: text,
    tone: connected ? "success" : "info",
    sticky: !automatic,
    durationMs: automatic ? 14_000 : undefined,
    dismissOn: automatic ? ["timeout", "click", "petClick"] : ["click", "petClick"]
  });
  if (automatic) await ctx.storage.set(SETUP_GUIDE_SEEN_KEY, true);
  return text;
}

async function showInvite(ctx) {
  const code = await ctx.storage.get(PARTNER_INVITE_KEY);
  await ctx.pet.speak(code ? `搭档邀请码：${code}` : "这里没有待使用的邀请码。请选择“创建 / 连接共享房间”，在表单里填写搭档发来的邀请码。");
}

async function diagnose(ctx) {
  const connected = Boolean(await token(ctx));
  if (!connected && !String((await setupDefaults(ctx)).nickname || "").trim()) {
    await setStatus(ctx, "setup");
    await ctx.pet.speak("还差一步：请选择“创建 / 连接共享房间”，在表单里填写昵称。");
    return false;
  }
  try {
    const health = await request(ctx, "/health");
    if (health.ok !== true) throw new Error("服务未返回正常健康状态");
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
  if (!deviceToken) {
    await setStatus(ctx, "setup");
    await showSetupGuide(ctx);
    return null;
  }
  const cursor = Number(await ctx.storage.get(CURSOR_KEY) || 0);
  const feed = await request(ctx, `/events?after=${Math.max(0, cursor - 50)}`, {}, deviceToken);
  const lines = (feed.events || []).slice(-8).reverse().map((event) => {
    const actor = ambientPart(event.actorName, "搭档");
    if (event.type === "CARE") return `${actor} · ${CARE_LABELS[event.payload.action] || "照顾"}`;
    if (event.type === "MESSAGE") return `${actor} · 传话`;
    if (event.type === "GIFT") return `${actor} · 送来${ambientPart(event.payload.gift, "一份礼物")}`;
    return `${actor} · ${ambientPart(event.type, "互动")}`;
  });
  await ctx.ui.bubble(lines.length
    ? { markdown: lines.join("\n"), sticky: true, tone: "info", dismissOn: ["click", "petClick"] }
    : { text: "还没有互动记录。", sticky: true, tone: "info" });
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
      const defaults = await setupDefaults(ctx);
      await ctx.commands.register({
        id: "connect",
        title: "$t:command.connect",
        description: "$t:command.connectDescription",
        placement: "top",
        featured: true,
        form: {
          fields: [
            { id: "nickname", type: "text", label: "$t:form.nickname", default: defaults.nickname, maxLength: 20, required: true },
            { id: "inviteCode", type: "text", label: "$t:form.inviteCode", default: defaults.inviteCode, maxLength: 32 }
          ],
          submitLabel: "$t:form.connect"
        }
      }, safeCommand(ctx, "connect", (values) => connect(ctx, values)));
      await ctx.commands.register({
        id: "disconnect",
        title: "$t:command.disconnect",
        description: "$t:command.disconnectDescription",
        form: {
          fields: [
            { id: "confirm", type: "boolean", label: "$t:form.disconnectConfirm", default: false, required: true }
          ],
          submitLabel: "$t:form.disconnect"
        }
      }, safeCommand(ctx, "disconnect", (values) => disconnect(ctx, values)));
      for (const action of Object.keys(CARE_LABELS)) {
        await ctx.commands.register({ id: action, title: CARE_LABELS[action] }, safeCommand(ctx, action, () => care(ctx, action)));
      }
      await ctx.commands.register({
        id: "message", title: "$t:command.message",
        form: { fields: [{ id: "text", type: "textarea", label: "$t:form.message", maxLength: 100, required: true }], submitLabel: "$t:form.send" }
      }, safeCommand(ctx, "message", (values) => sendMessage(ctx, values)));
      await ctx.commands.register({
        id: "gift", title: "$t:command.gift",
        form: { fields: [{ id: "gift", type: "select", label: "$t:form.gift", required: true, options: GIFTS.map((gift) => ({ label: gift, value: gift })) }], submitLabel: "$t:form.send" }
      }, safeCommand(ctx, "gift", (values) => sendGift(ctx, values)));
      await ctx.commands.register({ id: "history", title: "$t:command.history" }, safeCommand(ctx, "history", () => showHistory(ctx)));
      await ctx.commands.register({ id: "invite", title: "$t:command.invite" }, safeCommand(ctx, "invite", () => showInvite(ctx)));
      await ctx.commands.register({ id: "guide", title: "$t:command.guide", description: "$t:command.guideDescription" }, safeCommand(ctx, "guide", () => showSetupGuide(ctx)));
      await ctx.commands.register({ id: "diagnose", title: "$t:command.diagnose", description: "$t:command.diagnoseDescription" }, safeCommand(ctx, "diagnose", () => diagnose(ctx)));
      try {
        ctx.events.on("pet:clicked", async () => {
          try { await handlePetClick(ctx); } catch {}
        });
        ctx.events.on("offline", async () => {
          try { await handleOffline(ctx); } catch {}
        });
        for (const event of ["idle:enter", "idle:exit", "screen:locked"]) {
          ctx.events.on(event, async () => {
            try { await handlePresence(ctx, event); } catch {}
          });
        }
        for (const event of ["online", "screen:unlocked"]) {
          ctx.events.on(event, async () => {
            try {
              if (event === "screen:unlocked") await handlePresence(ctx, event);
              await handleRecovery(ctx);
            } catch {}
          });
        }
      } catch {}
      const snapshot = await ctx.storage.get(SNAPSHOT_KEY);
      if (snapshot) await updateHud(ctx, snapshot);
      if (await token(ctx)) await sync(ctx);
      else {
        await setStatus(ctx, "setup");
        if (!await ctx.storage.get(SETUP_GUIDE_SEEN_KEY)) {
          try { await showSetupGuide(ctx, true); }
          catch { try { await ctx.log.warn("First-time setup guide unavailable."); } catch {} }
        }
      }
      await scheduleNextSync(ctx);
    },
    async stop(ctx) {
      running.delete(ctx);
      try { await ctx.schedule.cancel(POLL_ID); } catch {}
      try { await ctx.schedule.cancel(CARE_ANIMATION_RESET_ID); } catch {}
      presenceState.delete(ctx);
      careAnimationUntil.delete(ctx);
      const handle = pinned.get(ctx);
      if (handle) { try { await handle.dismiss(); } catch {} }
      pinned.delete(ctx);
    }
  });
}
