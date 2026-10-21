import test from "node:test";
import assert from "node:assert/strict";
import {
  REMINDERS,
  buildReminderText,
  processAlarm,
  remainingLabel,
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
  const state = { now: nowMs, sent: [], persisted: [], notified: [], calls: 0, sleeps: [] };
  const queue = [...failures];

  return {
    state,
    args: {
      now: () => state.now,
      sleep: async (ms) => { state.sleeps.push(ms); },
      send: async (text) => {
        state.calls++;
        const next = queue.shift();
        if (next) throw next;
        state.sent.push(text);
      },
      persist: async (job) => { state.persisted.push(job.pending.length); },
      notify: async (failure) => { state.notified.push(failure); },
    },
  };
}

test("on-time 5 minute reminder keeps the approved wording", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN - 5 * 60000 });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.sent.length, 1);
  assert.match(h.state.sent[0], /🔥 \*\*BOSS 出現提醒\*\*/);
  assert.match(h.state.sent[0], /\*\*大象H\*\* 即將於 \*\*5 分鐘後\*\*出現/);
  assert.match(h.state.sent[0], /⏰ 出現時間：\*\*12:00:00\*\*/);
  assert.deepEqual(result.sent, [{ label: "5 分鐘" }]);
  assert.equal(job.pending.length, 1);
});

test("on-time 1 minute reminder keeps the approved wording", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[1], at: RESPAWN - 60000 }] });
  const h = harness({ nowMs: RESPAWN - 60000 + 1500 });
  await processAlarm({ job, ...h.args });
  assert.match(h.state.sent[0], /🚨/);
  assert.match(h.state.sent[0], /\*\*1 分鐘後\*\*出現/);
  assert.equal(job.pending.length, 0);
});

test("a boss that already respawned gets no reminder", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[1], at: RESPAWN - 60000 }] });
  for (const late of [0, 1, 500, 90000]) {
    const j = structuredClone(job);
    const h = harness({ nowMs: RESPAWN + late });
    const result = await processAlarm({ job: j, ...h.args });
    assert.equal(h.state.calls, 0, `late=${late}`);
    assert.equal(result.skipped[0].reason, "respawned");
    assert.equal(j.pending.length, 0);
  }
});

test("a late reminder states the real remaining time, not the original label", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[1], at: RESPAWN - 60000 }] });
  const h = harness({ nowMs: RESPAWN - 20000 });
  await processAlarm({ job, ...h.args });
  assert.match(h.state.sent[0], /\*\*20 秒後\*\*出現/);
  assert.doesNotMatch(h.state.sent[0], /1 分鐘/);
});

test("a late 5 minute reminder rounds up to whole minutes", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const h = harness({ nowMs: RESPAWN - 150000 });
  await processAlarm({ job, ...h.args });
  assert.match(h.state.sent[0], /\*\*3 分鐘後\*\*出現/);
});

test("both reminders due at once send only the latest one", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN - 20000 });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.sent.length, 1);
  assert.match(h.state.sent[0], /\*\*20 秒後\*\*出現/);
  assert.deepEqual(result.skipped, [{ label: "5 分鐘", reason: "superseded" }]);
  assert.equal(job.pending.length, 0);
});

test("a transient failure is retried inside the alarm and sent once", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const h = harness({ nowMs: RESPAWN - 300000, failures: [new Error("503"), new Error("503")] });
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

test("persistent failure asks Cloudflare to retry and keeps the reminder", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const err = new Error("503");
  const h = harness({ nowMs: RESPAWN - 300000, failures: [err, err, err] });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(result.retry, true);
  assert.equal(job.pending.length, 1);
  assert.equal(h.state.notified.length, 0);
});

test("a retried alarm does not resend a reminder that already went out", async () => {
  const job = makeJob();
  // 5 min reminder sent OK, then the 1 min reminder (due too) cannot be sent
  const early = harness({ nowMs: RESPAWN - 300000 });
  await processAlarm({ job, ...early.args });
  assert.equal(job.pending.length, 1);
  const err = new Error("503");
  const failing = harness({ nowMs: RESPAWN - 60000, failures: [err, err, err] });
  const first = await processAlarm({ job, ...failing.args });
  assert.equal(first.retry, true);
  const retry = harness({ nowMs: RESPAWN - 20000 });
  const second = await processAlarm({ job, ...retry.args });
  assert.equal(retry.state.sent.length, 1);
  assert.match(retry.state.sent[0], /\*\*20 秒後\*\*出現/);
  assert.equal(second.retry, false);
  assert.equal(job.pending.length, 0);
});

test("final retry that still fails gives up, notifies once and does not retry again", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const err = new Error("Discord Webhook failed: 503");
  const h = harness({ nowMs: RESPAWN - 280000, failures: [err, err, err] });
  const result = await processAlarm({ job, isLastRetry: true, ...h.args });
  assert.equal(result.retry, false);
  assert.equal(result.failed.length, 1);
  assert.equal(h.state.notified.length, 1);
  assert.equal(h.state.notified[0].bossName, "大象H");
  assert.equal(job.pending.length, 0);
});

test("a permanent error (dead webhook) is not retried and notifies immediately", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const dead = Object.assign(new Error("Discord Webhook failed: 404"), { permanent: true });
  const h = harness({ nowMs: RESPAWN - 300000, failures: [dead] });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 1);
  assert.equal(result.retry, false);
  assert.equal(h.state.notified.length, 1);
});

test("a failing alert channel never breaks the alarm", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const dead = Object.assign(new Error("404"), { permanent: true });
  const h = harness({ nowMs: RESPAWN - 300000, failures: [dead] });
  h.args.notify = async () => { throw new Error("relay down"); };
  const result = await processAlarm({ job, ...h.args });
  assert.equal(result.failed.length, 1);
});

test("reminders that are not due yet are untouched", async () => {
  const job = makeJob();
  const h = harness({ nowMs: RESPAWN - 400000 });
  const result = await processAlarm({ job, ...h.args });
  assert.equal(h.state.calls, 0);
  assert.equal(result.sent.length + result.skipped.length, 0);
  assert.equal(job.pending.length, 2);
});

test("remainingLabel boundaries", () => {
  assert.equal(remainingLabel(REMINDERS[0], 300000, 0), "5 分鐘");
  assert.equal(remainingLabel(REMINDERS[0], 270000, 30000), "5 分鐘");
  assert.equal(remainingLabel(REMINDERS[0], 269000, 31000), "5 分鐘".replace("5", String(Math.ceil(269000 / 60000))));
  assert.equal(remainingLabel(REMINDERS[1], 59000, 31000), "59 秒");
  assert.equal(remainingLabel(REMINDERS[1], 100, 59900), "1 秒");
});

test("randomized timelines never send after respawn, never duplicate, never send two for one boss at once", async () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 3000; run++) {
    const job = makeJob();
    const sentLabels = [];
    let t = RESPAWN - 300000 + Math.floor(rand() * 20000);
    let retryCount = 0;
    let finished = false;
    for (let step = 0; step < 12 && !finished; step++) {
      const failRate = rand() < 0.5 ? 0 : rand();
      const state = { sent: 0 };
      const result = await processAlarm({
        job,
        now: () => t,
        sleep: async () => { t += 10; },
        isLastRetry: retryCount >= 5,
        send: async (text) => {
          if (rand() < failRate) throw Object.assign(new Error("x"), { permanent: rand() < 0.1 });
          assert.ok(t < RESPAWN, "sent at/after respawn");
          state.sent++;
          sentLabels.push(text);
        },
        persist: async () => {},
        notify: async () => {},
      });
      assert.ok(state.sent <= 1, "more than one message in a single alarm");
      if (result.retry) { retryCount++; t += 2000 * 2 ** retryCount; }
      else { retryCount = 0; finished = job.pending.length === 0; t += Math.floor(rand() * 150000); }
      if (t > RESPAWN + 600000) break;
    }
    assert.equal(new Set(sentLabels).size, sentLabels.length, "duplicate message");
  }
});

test("a reminder that keeps failing until the boss respawns is reported, not silently dropped", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[1], at: RESPAWN - 60000 }] });
  const err = new Error("Discord Webhook failed: 503");
  const first = harness({ nowMs: RESPAWN - 60000, failures: [err, err, err] });
  const r1 = await processAlarm({ job, ...first.args });
  assert.equal(r1.retry, true);
  assert.ok(job.failed, "failure must be remembered for the next attempt");

  const later = harness({ nowMs: RESPAWN + 20000 });
  const r2 = await processAlarm({ job, ...later.args });
  assert.equal(later.state.calls, 0, "never sends after respawn");
  assert.equal(r2.failed.length, 1);
  assert.equal(r2.failed[0].reason, "expired-while-retrying");
  assert.equal(later.state.notified.length, 1);
  assert.equal(later.state.notified[0].bossName, "大象H");
  assert.equal(job.pending.length, 0);
});

test("recovery after a failure clears the failure marker and sends no alert", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[0], at: RESPAWN - 300000 }] });
  const err = new Error("503");
  await processAlarm({ job, ...harness({ nowMs: RESPAWN - 300000, failures: [err, err, err] }).args });
  assert.ok(Object.keys(job.failed).length === 1);
  const ok = harness({ nowMs: RESPAWN - 290000 });
  await processAlarm({ job, ...ok.args });
  assert.equal(ok.state.sent.length, 1);
  assert.equal(ok.state.notified.length, 0);
  assert.deepEqual(job.failed, {});
});

test("a normal respawn skip (no earlier failure) does not alert", async () => {
  const job = makeJob({ pending: [{ ...REMINDERS[1], at: RESPAWN - 60000 }] });
  const h = harness({ nowMs: RESPAWN + 1000 });
  await processAlarm({ job, ...h.args });
  assert.equal(h.state.notified.length, 0);
});
