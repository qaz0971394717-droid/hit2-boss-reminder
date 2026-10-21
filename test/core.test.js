import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LATE_MS,
  REMINDERS,
  buildReminderText,
  normalizeJob,
  processAlarm,
  sendWithRetry,
} from "../src/reminder-core.js";

const RESPAWN = Date.parse("2026-10-22T04:00:00.000Z");

function makeJob(overrides = {}) {
  return {
    version: 3,
    chatId: "Cgroup",
    bossKey: "大象h",
    bossName: "大象H",
    respawnAt: new Date(RESPAWN).toISOString(),
    pending: REMINDERS.map((r) => ({ ...r, at: RESPAWN - r.beforeMs })),
    ...overrides,
  };
}

function harness({ nowMs, failures = [] } = {}) {
  const state = { now: nowMs, sent: [], notified: [], calls: 0, sleeps: [] };
  const queue = [...failures];

  return {
    state,
    args: {
      now: () => state.now,
      sleep: async (ms) => { state.sleeps.push(ms); state.now += ms; },
      send: async (text) => {
        state.calls++;
        const next = queue.shift();
        if (next) throw next;
        state.sent.push({ text, at: state.now });
      },
      persist: async () => {},
      notify: async (failure) => { state.notified.push(failure); },
    },
  };
}

test("there is exactly one reminder and it fires at the respawn moment", () => {
  assert.equal(REMINDERS.length, 1);
  assert.equal(REMINDERS[0].beforeMs, 0);
});

test("message states the boss is respawned and the exact respawn time", () => {
  const text = buildReminderText(makeJob());
  assert.equal(text, "⚔️ **大象H 已重生**\n⏰ 重生時間：**12:00:00**");
});

test("an on-time alarm sends one message and finishes the job", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.sent.length, 1);
  assert.match(h.state.sent[0].text, /大象H 已重生/);
  assert.equal(job.pending.length, 0);
  assert.equal(result.retry, false);
});

test("an alarm that fires slightly early waits until the exact respawn time", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN - 1500 });
  await processAlarm({ job, ...h.args });
  assert.deepEqual(h.state.sleeps, [1500]);
  assert.equal(h.state.sent[0].at, RESPAWN, "must not be sent before the respawn time");
});

test("an alarm more than 3 seconds early does nothing yet", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN - 10000 });
  await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 0);
  assert.equal(job.pending.length, 1);
});

test("a late alarm still sends, and the text shows the real respawn time", async () => {
  for (const late of [1000, 30000, 120000, MAX_LATE_MS]) {
    const job = makeJob();
    const h = harness({ nowMs: RESPAWN + late });
    await processAlarm({ job, ...h.args });
    assert.equal(h.state.sent.length, 1, `late=${late}`);
    assert.match(h.state.sent[0].text, /重生時間：\*\*12:00:00\*\*/);
  }
});

test("more than 5 minutes late is not sent but is reported", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN + MAX_LATE_MS + 1000 });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 0);
  assert.equal(result.failed[0].reason, "too-late");
  assert.equal(h.state.notified.length, 1);
  assert.equal(job.pending.length, 0);
});

test("a transient failure is retried inside the alarm and sent once", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN, failures: [new Error("503"), new Error("503")] });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 3);
  assert.equal(h.state.sent.length, 1);
  assert.equal(result.retry, false);
  assert.deepEqual(h.state.sleeps, [1000, 2000]);
});

test("rate limit waits the Retry-After time but never more than 5 seconds", async () => {
  const limited = Object.assign(new Error("429"), { retryAfterMs: 2500 });
  const huge = Object.assign(new Error("429"), { retryAfterMs: 60000 });
  const h = harness({ nowMs: 0, failures: [limited, huge] });
  const out = await sendWithRetry(h.args.send, "x", { sleep: h.args.sleep });
  assert.equal(out.ok, true);
  assert.deepEqual(h.state.sleeps, [2500, 5000]);
});

test("persistent failure asks Cloudflare to retry and keeps the notification", async () => {
  const job = makeJob();
  const err = new Error("503");
  const h = harness({ nowMs: RESPAWN, failures: [err, err, err] });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(result.retry, true);
  assert.equal(job.pending.length, 1);
  assert.equal(h.state.notified.length, 0);
});

test("a successful retry sends exactly one message and clears the failure marker", async () => {
  const job = makeJob();
  const err = new Error("503");
  await processAlarm({ job, ...harness({ nowMs: RESPAWN, failures: [err, err, err] }).args });
  assert.equal(Object.keys(job.failed).length, 1);
  const retry = harness({ nowMs: RESPAWN + 5000 });
  const result = await processAlarm({ job, ...retry.args });
  assert.equal(retry.state.sent.length, 1);
  assert.equal(result.retry, false);
  assert.deepEqual(job.failed, {});
  assert.equal(retry.state.notified.length, 0);
});

test("final retry that still fails gives up and notifies once", async () => {
  const job = makeJob();
  const err = new Error("Discord Webhook failed: 503");
  const h = harness({ nowMs: RESPAWN + 60000, failures: [err, err, err] });
  const result = await processAlarm({ job, isLastRetry: true, ...h.args });
  assert.equal(result.retry, false);
  assert.equal(result.failed[0].reason, "gave-up");
  assert.equal(h.state.notified.length, 1);
  assert.equal(job.pending.length, 0);
});

test("failing past the 5 minute limit is reported as expired, never sent late", async () => {
  const job = makeJob();
  const err = new Error("503");
  await processAlarm({ job, ...harness({ nowMs: RESPAWN, failures: [err, err, err] }).args });
  const later = harness({ nowMs: RESPAWN + MAX_LATE_MS + 5000 });
  const result = await processAlarm({ job, ...later.args });
  assert.equal(later.state.calls, 0);
  assert.equal(result.failed[0].reason, "expired-while-retrying");
  assert.equal(later.state.notified.length, 1);
});

test("a permanent error (dead webhook) is not retried and notifies immediately", async () => {
  const job = makeJob();
  const dead = Object.assign(new Error("Discord Webhook failed: 404"), { permanent: true });
  const h = harness({ nowMs: RESPAWN, failures: [dead] });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 1);
  assert.equal(result.retry, false);
  assert.equal(h.state.notified.length, 1);
});

test("a failing alert channel never breaks the alarm", async () => {
  const job = makeJob();
  const dead = Object.assign(new Error("404"), { permanent: true });
  const h = harness({ nowMs: RESPAWN, failures: [dead] });
  h.args.notify = async () => { throw new Error("relay down"); };
  const result = await processAlarm({ job, ...h.args });
  assert.equal(result.failed.length, 1);
});

// ---- legacy jobs scheduled by the previous version (5 min / 1 min before) ----

const legacy = (respawnMs, { fiveMin = true } = {}) => ({
  version: 3,
  chatId: "Cgroup",
  bossKey: "x",
  bossName: "舊王",
  respawnAt: new Date(respawnMs).toISOString(),
  pending: [
    ...(fiveMin ? [{ beforeMs: 300000, label: "5 分鐘", icon: "🔥", at: respawnMs - 300000 }] : []),
    { beforeMs: 60000, label: "1 分鐘", icon: "🚨", at: respawnMs - 60000 },
  ],
});

test("legacy jobs are converted to a single respawn notification", () => {
  const job = normalizeJob(legacy(RESPAWN), RESPAWN - 600000);
  assert.equal(job.pending.length, 1);
  assert.equal(job.pending[0].beforeMs, 0);
  assert.equal(job.pending[0].at, RESPAWN);
  assert.equal(job.pending[0].label, "已重生");
});

test("a legacy 5 minute alarm firing after deploy sends nothing and keeps the respawn one", async () => {
  const job = legacy(RESPAWN);
  const h = harness({ nowMs: RESPAWN - 300000 });
  await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 0, "must not announce a respawn 5 minutes early");
  assert.equal(job.pending.length, 1);
  assert.equal(job.pending[0].at, RESPAWN);
});

test("a legacy 1 minute alarm firing after deploy sends nothing early", async () => {
  const job = legacy(RESPAWN, { fiveMin: false });
  const h = harness({ nowMs: RESPAWN - 60000 });
  await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 0);
  assert.equal(job.pending[0].at, RESPAWN);
});

test("normalizing an already converted job changes nothing", () => {
  const job = makeJob();
  const before = JSON.stringify(job);
  normalizeJob(job, RESPAWN - 1000);
  assert.equal(JSON.stringify(job), before);
});

test("a finished job is never re-created by normalization", () => {
  const job = makeJob({ pending: [] });
  normalizeJob(job, RESPAWN + 1000);
  assert.equal(job.pending.length, 0);
});

test("randomized timelines: one message per boss, never early, never later than 5 minutes", async () => {
  let seed = 20261022;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 4000; run++) {
    const job = rand() < 0.3 ? legacy(RESPAWN, { fiveMin: rand() < 0.5 }) : makeJob();
    const sentAt = [];
    let t = RESPAWN - Math.floor(rand() * 400000);
    let retryCount = 0;
    for (let step = 0; step < 14; step++) {
      const failRate = rand() < 0.5 ? 0 : rand();
      const result = await processAlarm({
        job,
        now: () => t,
        sleep: async (ms) => { t += ms; },
        isLastRetry: retryCount >= 5,
        send: async () => {
          if (rand() < failRate) throw Object.assign(new Error("x"), { permanent: rand() < 0.1 });
          sentAt.push(t);
        },
        persist: async () => {},
        notify: async () => {},
      });
      if (result.retry) { retryCount++; t += 2000 * 2 ** retryCount; }
      else { retryCount = 0; t += Math.floor(rand() * 200000); }
      if (!job.pending.length) break;
    }
    assert.ok(sentAt.length <= 1, "more than one notification for a boss");
    for (const at of sentAt) {
      assert.ok(at >= RESPAWN, "sent before the respawn time");
      assert.ok(at - RESPAWN <= MAX_LATE_MS, "sent more than 5 minutes late");
    }
  }
});
