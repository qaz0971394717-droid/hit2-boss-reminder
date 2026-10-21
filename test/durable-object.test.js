import test from "node:test";
import assert from "node:assert/strict";
import worker, { BossReminder } from "../src/index.js";

const RESPAWN = Date.parse("2026-10-22T04:00:00.000Z");
const CHAT = "Cgroupgroupgroupgroupgroupgroupgrou";

function makeObject(envOverrides = {}) {
  const store = new Map();
  const alarm = { at: null, set: 0 };
  const ctx = {
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      put: async (k, v) => { store.set(k, structuredClone(v)); },
      delete: async (k) => { store.delete(k); },
      setAlarm: async (t) => { alarm.at = t; alarm.set++; },
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
  Date.now = () => clock.now;
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  return { clock, restore() { Date.now = realNow; globalThis.setTimeout = realSetTimeout; } };
}

function withFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    return handler(url, init, calls.length);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const ok = () => new Response(null, { status: 204 });
const fail = (status, body = "") => new Response(body, { status });

const payload = {
  chatId: CHAT, bossKey: "大象h", bossName: "大象H",
  respawnAt: new Date(RESPAWN).toISOString(),
};

test("schedule + on-time alarms send two reminders and clean up", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch(() => ok());
  try {
    const { object, store, alarm } = makeObject();
    const res = await object.schedule(payload);
    assert.equal(res.pending, 2);
    assert.equal(alarm.at, RESPAWN - 300000);

    t.clock.now = RESPAWN - 300000;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].body.content, /5 分鐘後/);
    assert.equal(alarm.at, RESPAWN - 60000);

    t.clock.now = RESPAWN - 60000;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].body.content, /1 分鐘後/);
    assert.equal(store.has("job"), false);
    assert.equal(alarm.at, null);
  } finally { t.restore(); f.restore(); }
});

test("late alarm after respawn sends nothing and cleans up", async () => {
  const t = withClock(RESPAWN - 600000);
  const f = withFetch(() => ok());
  try {
    const { object, store } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN + 5000;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 0);
    assert.equal(store.has("job"), false);
  } finally { t.restore(); f.restore(); }
});

test("Discord outage: alarm throws so Cloudflare retries, then succeeds without duplicates", async () => {
  const t = withClock(RESPAWN - 600000);
  let down = true;
  const f = withFetch(() => (down ? fail(503, "unavailable") : ok()));
  try {
    const { object, store } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN - 300000;
    await assert.rejects(() => object.alarm({ retryCount: 0 }), /will retry/);
    assert.equal(f.calls.length, 3);
    assert.equal(store.get("job").pending.length, 2, "reminder must be kept for retry");

    down = false;
    t.clock.now = RESPAWN - 290000;
    await object.alarm({ retryCount: 1 });
    assert.equal(f.calls.length, 4);
    assert.match(f.calls[3].body.content, /5 分鐘後|\d+ 分鐘後/);
    assert.equal(store.get("job").pending.length, 1);
  } finally { t.restore(); f.restore(); }
});

test("rate limited (429) is retried honouring retry_after", async () => {
  const t = withClock(RESPAWN - 400000);
  const sleeps = [];
  globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); fn(); return 0; };
  let n = 0;
  const f = withFetch(() => (++n === 1 ? fail(429, JSON.stringify({ retry_after: 1.5 })) : ok()));
  try {
    const { object } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN - 300000;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(sleeps, [1500]);
  } finally { t.restore(); f.restore(); }
});

test("dead webhook (404) is not retried; ops alert is sent when configured", async () => {
  const t = withClock(RESPAWN - 400000);
  const f = withFetch((url) => (String(url).includes("ops.test") ? ok() : fail(404, "Unknown Webhook")));
  try {
    const { object, store } = makeObject({
      OPS_ALERT_URL: "https://ops.test/ops/notify",
      OPS_ALERT_KEY: "secret-key",
    });
    await object.schedule(payload);
    t.clock.now = RESPAWN - 300000;
    await object.alarm({ retryCount: 0 });
    const discord = f.calls.filter((c) => String(c.url).includes("discord.test"));
    const ops = f.calls.filter((c) => String(c.url).includes("ops.test"));
    assert.equal(discord.length, 1, "404 must not be retried");
    assert.equal(ops.length, 1);
    assert.equal(ops[0].headers.authorization, "Bearer secret-key");
    assert.equal(ops[0].body.target, "production");
    assert.equal(ops[0].body.kind, "alert");
    assert.match(ops[0].body.retryKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(ops[0].body.message, /大象H/);
    assert.equal(store.get("job").pending.length, 1, "later reminder is still scheduled");
  } finally { t.restore(); f.restore(); }
});

test("last Cloudflare retry gives up and alerts instead of throwing forever", async () => {
  const t = withClock(RESPAWN - 400000);
  const f = withFetch((url) => (String(url).includes("ops.test") ? ok() : fail(503, "down")));
  try {
    const { object } = makeObject({ OPS_ALERT_URL: "https://ops.test/n", OPS_ALERT_KEY: "k" });
    await object.schedule(payload);
    t.clock.now = RESPAWN - 300000;
    await object.alarm({ retryCount: 5 });
    assert.equal(f.calls.filter((c) => String(c.url).includes("ops.test")).length, 1);
  } finally { t.restore(); f.restore(); }
});

test("without ops settings a failure only logs and the alarm still completes", async () => {
  const t = withClock(RESPAWN - 400000);
  const f = withFetch(() => fail(404, "gone"));
  try {
    const { object } = makeObject();
    await object.schedule(payload);
    t.clock.now = RESPAWN - 300000;
    await object.alarm({ retryCount: 0 });
    assert.equal(f.calls.length, 1);
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

test("rescheduling replaces the old reminder and cancel removes it", async () => {
  const t = withClock(RESPAWN - 900000);
  const f = withFetch(() => ok());
  try {
    const { object, store, alarm } = makeObject();
    await object.schedule(payload);
    await object.schedule({ ...payload, respawnAt: new Date(RESPAWN + 600000).toISOString() });
    assert.equal(alarm.at, RESPAWN + 600000 - 300000);
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

test("1 minute reminder that fails until respawn raises an ops alert on the final alarm", async () => {
  const t = withClock(RESPAWN - 200000);
  const f = withFetch((url) => (String(url).includes("ops.test") ? ok() : fail(503, "down")));
  try {
    const { object, store } = makeObject({ OPS_ALERT_URL: "https://ops.test/n", OPS_ALERT_KEY: "k" });
    await object.schedule({ ...payload, respawnAt: new Date(RESPAWN).toISOString() });
    t.clock.now = RESPAWN - 300000 + 240000; // 1 minute mark
    await assert.rejects(() => object.alarm({ retryCount: 0 }), /will retry/);
    assert.equal(f.calls.filter((c) => String(c.url).includes("ops.test")).length, 0);
    t.clock.now = RESPAWN + 30000; // last Cloudflare retry happens after the respawn
    await object.alarm({ retryCount: 5 });
    assert.equal(f.calls.filter((c) => String(c.url).includes("ops.test")).length, 1);
    assert.equal(store.has("job"), false);
  } finally { t.restore(); f.restore(); }
});
