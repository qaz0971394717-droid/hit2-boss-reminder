import { DurableObject } from "cloudflare:workers";

const REMINDERS = [
  { beforeMs: 10 * 60 * 1000, label: "10 分鐘", icon: "⚠️" },
  { beforeMs: 5 * 60 * 1000, label: "5 分鐘", icon: "🔥" },
  { beforeMs: 1 * 60 * 1000, label: "1 分鐘", icon: "🚨" },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const expected = env.REMINDER_API_KEY;
  const got = request.headers.get("authorization");
  return expected && got === `Bearer ${expected}`;
}

async function linePush(token, chatId, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: chatId,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `LINE Push failed: ${response.status} ${await response.text()}`
    );
  }
}

export class BossReminder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async schedule(data) {
    const { chatId, bossKey, bossName, respawnAt } = data;

    if (!chatId || !bossKey || !bossName || !respawnAt) {
      return { ok: false, error: "missing fields" };
    }

    const respawnMs = Date.parse(respawnAt);

    if (!Number.isFinite(respawnMs)) {
      return { ok: false, error: "invalid respawnAt" };
    }

    const job = {
      chatId,
      bossKey,
      bossName,
      respawnAt: new Date(respawnMs).toISOString(),
      pending: REMINDERS
        .map((r) => ({
          ...r,
          at: respawnMs - r.beforeMs,
        }))
        .filter((r) => r.at > Date.now()),
    };

    await this.ctx.storage.put("job", job);
    await this.setNextAlarm(job);

    return {
      ok: true,
      pending: job.pending.length,
    };
  }

  async cancel() {
    await this.ctx.storage.delete("job");
    await this.ctx.storage.deleteAlarm();

    return { ok: true };
  }

  async setNextAlarm(job) {
    if (!job.pending.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    job.pending.sort((a, b) => a.at - b.at);

    await this.ctx.storage.setAlarm(job.pending[0].at);
  }

  async alarm() {
    const job = await this.ctx.storage.get("job");

    if (!job) {
      return;
    }

    const now = Date.now();

    const due = job.pending.filter(
      (r) => r.at <= now + 3000
    );

    job.pending = job.pending.filter(
      (r) => r.at > now + 3000
    );

    for (const r of due) {
      const respawn = new Date(job.respawnAt);

      const time = new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(respawn);

      const text =
        `${r.icon} BOSS 出現提醒\n\n` +
        `${job.bossName} 即將於 ${r.label}後出現\n` +
        `⏰ 出現時間：${time}`;

      await linePush(
        this.env.LINE_CHANNEL_ACCESS_TOKEN,
        job.chatId,
        text
      );
    }

    if (job.pending.length) {
      await this.ctx.storage.put("job", job);
      await this.setNextAlarm(job);
    } else {
      await this.ctx.storage.delete("job");
      await this.ctx.storage.deleteAlarm();
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "hit2-boss-reminder",
      });
    }

    if (!authorized(request, env)) {
      return json(
        { ok: false, error: "unauthorized" },
        401
      );
    }

    const url = new URL(request.url);

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        { ok: false, error: "invalid json" },
        400
      );
    }

    const { chatId, bossKey } = body;

    if (!chatId || !bossKey) {
      return json(
        {
          ok: false,
          error: "chatId and bossKey required",
        },
        400
      );
    }

    const id = env.BOSS_REMINDER.idFromName(
      `${chatId}:${bossKey}`
    );

    const stub = env.BOSS_REMINDER.get(id);

    if (
      request.method === "POST" &&
      url.pathname === "/schedule"
    ) {
      return json(
        await stub.schedule(body)
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/cancel"
    ) {
      return json(
        await stub.cancel()
      );
    }

    return json(
      { ok: false, error: "not found" },
      404
    );
  },
};
