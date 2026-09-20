import { DurableObject } from "cloudflare:workers";

const REMINDERS = [
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


// ================================
// Discord Webhook
// ================================

async function discordPush(webhookUrl, text) {
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is not configured");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: text,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Discord Webhook failed: ${response.status} ${await response.text()}`
    );
  }
}


// ================================
// Durable Object
// ================================

export class BossReminder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
  }


  // ==============================
  // 建立 BOSS 提醒
  // ==============================

  async schedule(data) {
    const {
      chatId,
      bossKey,
      bossName,
      respawnAt,
    } = data;

    if (!chatId || !bossKey || !bossName || !respawnAt) {
      return {
        ok: false,
        error: "missing fields",
      };
    }

    const respawnMs = Date.parse(respawnAt);

    if (!Number.isFinite(respawnMs)) {
      return {
        ok: false,
        error: "invalid respawnAt",
      };
    }


    const job = {
      // version 2 = Discord 版本
      version: 2,

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


    await this.ctx.storage.put(
      "job",
      job
    );

    await this.setNextAlarm(job);


    return {
      ok: true,
      version: 2,
      destination: "discord",
      pending: job.pending.length,
    };
  }


  // ==============================
  // 取消單一 BOSS
  // ==============================

  async cancel() {
    await this.ctx.storage.delete("job");
    await this.ctx.storage.deleteAlarm();

    return {
      ok: true,
    };
  }


  // ==============================
  // 設定下一個 Alarm
  // ==============================

  async setNextAlarm(job) {
    if (!job.pending.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    job.pending.sort(
      (a, b) => a.at - b.at
    );

    await this.ctx.storage.setAlarm(
      job.pending[0].at
    );
  }


  // ==============================
  // Alarm 到時間
  // ==============================

  async alarm() {
    const job =
      await this.ctx.storage.get("job");


    if (!job) {
      return;
    }


    // ============================
    // 舊 LINE 排程保護
    // ============================

    if (job.version !== 2) {

      console.log(
        "Old LINE reminder skipped:",
        job.bossName
      );

      await this.ctx.storage.delete("job");
      await this.ctx.storage.deleteAlarm();

      return;
    }


    const now = Date.now();


    const due = job.pending.filter(
      (r) => r.at <= now + 3000
    );


    job.pending = job.pending.filter(
      (r) => r.at > now + 3000
    );


    // ============================
    // 發送 Discord 提醒
    // ============================

    for (const r of due) {

      const respawn =
        new Date(job.respawnAt);


      const time =
        new Intl.DateTimeFormat(
          "zh-TW",
          {
            timeZone: "Asia/Taipei",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }
        ).format(respawn);


      const text =
        `${r.icon} **BOSS 出現提醒**\n\n` +
        `**${job.bossName}** 即將於 **${r.label}後**出現\n` +
        `⏰ 出現時間：**${time}**`;


      await discordPush(
        this.env.DISCORD_WEBHOOK_URL,
        text
      );
    }


    // ============================
    // 下一個提醒
    // ============================

    if (job.pending.length) {

      await this.ctx.storage.put(
        "job",
        job
      );

      await this.setNextAlarm(job);

    } else {

      await this.ctx.storage.delete(
        "job"
      );

      await this.ctx.storage.deleteAlarm();
    }
  }
}


// =================================
// Worker API
// =================================

export default {

  async fetch(request, env) {

    // 健康檢查
    if (request.method === "GET") {

      return json({
        ok: true,
        service: "hit2-boss-reminder",
        destination: "discord",
        version: 2,
      });
    }


    // API Key 驗證
    if (!authorized(request, env)) {

      return json(
        {
          ok: false,
          error: "unauthorized",
        },
        401
      );
    }


    const url =
      new URL(request.url);


    let body;


    try {

      body =
        await request.json();

    } catch {

      return json(
        {
          ok: false,
          error: "invalid json",
        },
        400
      );
    }


    const {
      chatId,
      bossKey,
    } = body;


    if (!chatId || !bossKey) {

      return json(
        {
          ok: false,
          error:
            "chatId and bossKey required",
        },
        400
      );
    }


    // 每個 LINE 群組 + BOSS
    // 都是獨立計時器
    const id =
      env.BOSS_REMINDER.idFromName(
        `${chatId}:${bossKey}`
      );


    const stub =
      env.BOSS_REMINDER.get(id);


    // 建立提醒
    if (
      request.method === "POST" &&
      url.pathname === "/schedule"
    ) {

      return json(
        await stub.schedule(body)
      );
    }


    // 取消提醒
    if (
      request.method === "POST" &&
      url.pathname === "/cancel"
    ) {

      return json(
        await stub.cancel()
      );
    }


    return json(
      {
        ok: false,
        error: "not found",
      },
      404
    );
  },
};
