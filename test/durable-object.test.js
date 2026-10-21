import test from "node:test";
import assert from "node:assert/strict";
import worker, { BossReminder } from "../src/index.js";

const RESPAWN = Date.parse("2026-10-22T04:00:00.000Z");
const CHAT = "Cgroupgroupgroupgroupgroupgroupgrou";

function makeObject(envOverrides = {}) {
  const store = new Map();
  const alarm = { at: null };
  const ctx = {
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      put: async (k, v) => { store.set(k, structuredClone(v)); },
      delete: async (k) => { store.delete(k); },
      setAlarm: async (t) => { alarm.at = t; },
      deleteAlarm: async () => { alarm.at = null; },
    },
  };
  const env = {
    DISCORD_LINE_CHAT_ID: CHAT,
    DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
    ...envOverrides,
  };
  return { object: new BossReminder(ctx, env), store, alarm, env };
}

function withClock(initial) {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const clock = { now: initial };
  const sleeps = [];
  Date.now = () => clock.now;
  globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); clock.now += ms; fn(); return 0; };
  return { clock, sleeps, restore() { Date.now = realNow; globalThis.setTimeout = realSetTimeout; } };
}

function withFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    return handler(String(url), init, calls.length);
  };
  return {
    calls,
    discord: () => calls.filter((c) => c.url.includes("discord.test")),
    ops: () => calls.filter((c) => c.url.includes("ops.test")),
    restore() { globalThis.fetch = real; },
  };
}

const ok = () => new Response(null, { status: 204 });
const fail = (status, body = "") => new Response(body, { status });

const payload = {
  chatId: CHAT, bossKey: "大象h", bossName: "大象H",
  respawnAt: new Date(RESPAWN).toISOString(),
};

test("schedule sets one alarm at the respawn time; the alarm sends one message and cleans up", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch(() => ok());
  try {
    const { object, store, alarm } = makeObject();
    const res = await object.schedule(payload);
    assert.equal(res.pending, 1);
    assert.equal(alarm.at, RESPAWN);

    t.clock.now = RESPAWN;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.discord().length, 1);
    assert.equal(f.discord()[0].body.content, "⚔️ **大象H 已重生**\n⏰ 重生時間：**12:00:00**");
    assert.equal(store.has("job"), false);
    assert.equal(alarm.at, null);
  } finally { t.restore(); f.restore(); }
});

test("a boss whose respawn time is already past is not scheduled", async () => {
  const t = withClock(RESPAWN + 1000);
  const f = withFetch(() => ok());
  try {
    const { object, alarm } = makeObject();
    const res = await object.schedule(payload);
    assert.equal(res.pending, 0);
    assert.equal(alarm.at, null);
    assert.equal(f.calls.length, 0);
  } finally { t.restore(); f.restore(); }
});

test("an alarm that fires a moment early waits for the exact respawn time", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch(() => ok());
  try {
    const { object } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN - 800;
    await object.alarm({ retryCount: 0 });
    assert.deepEqual(t.sleeps, [800]);
    assert.equal(Date.now(), RESPAWN);
    assert.equal(f.discord().length, 1);
  } finally { t.restore(); f.restore(); }
});

test("Discord outage: alarm throws so Cloudflare retries, then succeeds exactly once", async () => {
  const t = withClock(RESPAWN - 600000);
  let down = true;
  const f = withFetch(() => (down ? fail(503, "unavailable") : ok()));
  try {
    const { object, store } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    await assert.rejects(() => object.alarm({ retryCount: 0 }), /will retry/);
    assert.equal(f.discord().length, 3);
    assert.equal(store.get("job").pending.length, 1, "notification must be kept for the retry");

    down = false;
    t.clock.now += 5000;
    await object.alarm({ retryCount: 1 });
    assert.equal(f.discord().length, 4);
    assert.equal(store.has("job"), false);

    await object.alarm({ retryCount: 2 }); // a stray extra alarm must do nothing
    assert.equal(f.discord().length, 4);
  } finally { t.restore(); f.restore(); }
});

test("rate limited (429) is retried honouring retry_after", async () => {
  const t = withClock(RESPAWN - 600000);
  let n = 0;
  const f = withFetch(() => (++n === 1 ? fail(429, JSON.stringify({ retry_after: 1.5 })) : ok()));
  try {
    const { object } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    t.sleeps.length = 0;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.discord().length, 2);
    assert.deepEqual(t.sleeps, [1500]);
  } finally { t.restore(); f.restore(); }
});

test("dead webhook (404) is not retried; ops alert is sent when configured", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch((url) => (url.includes("ops.test") ? ok() : fail(404, "Unknown Webhook")));
  try {
    const { object, store } = makeObject({ OPS_ALERT_URL: "https://ops.test/ops/notify", OPS_ALERT_KEY: "secret-key" });
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.discord().length, 1, "404 must not be retried");
    assert.equal(f.ops().length, 1);
    assert.equal(f.ops()[0].headers.authorization, "Bearer secret-key");
    assert.equal(f.ops()[0].body.target, "production");
    assert.equal(f.ops()[0].body.kind, "alert");
    assert.match(f.ops()[0].body.retryKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(f.ops()[0].body.message, /大象H/);
    assert.equal(store.has("job"), false);
  } finally { t.restore(); f.restore(); }
});

test("last Cloudflare retry gives up and alerts instead of throwing forever", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch((url) => (url.includes("ops.test") ? ok() : fail(503, "down")));
  try {
    const { object } = makeObject({ OPS_ALERT_URL: "https://ops.test/n", OPS_ALERT_KEY: "k" });
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    await object.alarm({ retryCount: 5 });
    assert.equal(f.ops().length, 1);
  } finally { t.restore(); f.restore(); }
});

test("failing until more than 5 minutes after respawn raises an ops alert and stops", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch((url) => (url.includes("ops.test") ? ok() : fail(503, "down")));
  try {
    const { object, store } = makeObject({ OPS_ALERT_URL: "https://ops.test/n", OPS_ALERT_KEY: "k" });
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    await assert.rejects(() => object.alarm({ retryCount: 0 }), /will retry/);
    t.clock.now = RESPAWN + 6 * 60000;
    const before = f.discord().length;
    await object.alarm({ retryCount: 4 });
    assert.equal(f.discord().length, before, "must not send a stale notification");
    assert.equal(f.ops().length, 1);
    assert.equal(store.has("job"), false);
  } finally { t.restore(); f.restore(); }
});

test("without ops settings a failure only logs and the alarm still completes", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch(() => fail(404, "gone"));
  try {
    const { object } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.discord().length, 1);
  } finally { t.restore(); f.restore(); }
});

test("a job stored by the previous version is converted when its old alarm fires", async () => {
  const t = withClock(RESPAWN - 300000);
  const f = withFetch(() => ok());
  try {
    const { object, store, alarm } = makeObject();
    store.set("job", {
      version: 3, chatId: CHAT, bossKey: "x", bossName: "舊王",
      respawnAt: new Date(RESPAWN).toISOString(),
      pending: [
        { beforeMs: 300000, label: "5 分鐘", icon: "🔥", at: RESPAWN - 300000 },
        { beforeMs: 60000, label: "1 分鐘", icon: "🚨", at: RESPAWN - 60000 },
      ],
    });
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 0, "no early message from an old schedule");
    assert.equal(store.get("job").pending.length, 1);
    assert.equal(alarm.at, RESPAWN);

    t.clock.now = RESPAWN;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.discord().length, 1);
    assert.match(f.discord()[0].body.content, /舊王 已重生/);
    assert.equal(store.has("job"), false);
  } finally { t.restore(); f.restore(); }
});

test("unmapped group is never scheduled or sent", async () => {
  const f = withFetch(() => ok());
  try {
    const { object } = makeObject();
    const res = await object.schedule({ ...payload, chatId: "Cother" });
    assert.equal(res.skipped, true);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("rescheduling replaces the old time and cancel removes it", async () => {
  const t = withClock(RESPAWN - 900000);
  const f = withFetch(() => ok());
  try {
    const { object, store, alarm } = makeObject();
    await object.schedule(payload);
    await object.schedule({ ...payload, respawnAt: new Date(RESPAWN + 600000).toISOString() });
    assert.equal(alarm.at, RESPAWN + 600000);
    await object.cancel();
    assert.equal(store.has("job"), false);
    assert.equal(alarm.at, null);
  } finally { t.restore(); f.restore(); }
});

test("health check and auth behaviour are unchanged", async () => {
  const health = await worker.fetch(new Request("https://x/"), {});
  assert.equal((await health.json()).ok, true);
  const denied = await worker.fetch(new Request("https://x/schedule", { method: "POST", body: "{}" }), { REMINDER_API_KEY: "k" });
  assert.equal(denied.status, 401);
});
