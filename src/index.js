import { DurableObject } from "cloudflare:workers";

import {
  REMINDERS,
  LAST_RETRY_COUNT,
  processAlarm,
} from "./reminder-core.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function authorized(request, env) {
  const expected = env.REMINDER_API_KEY;
  const got = request.headers.get("authorization");

  return expected && got === `Bearer ${expected}`;
}


// =========================================================
// Discord Webhook
// =========================================================

async function discordPush(webhookUrl, text) {
  if (!webhookUrl) {
    const error = new Error(
      "DISCORD_WEBHOOK_URL is not configured"
    );

    error.permanent = true;

    throw error;
  }

  const response = await fetch(
    webhookUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: text,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    const error = new Error(
      `Discord Webhook failed: ${response.status} ${body}`
    );

    // 429 / 408 / 5xx 可以再試；其他 4xx（網址失效、權限）重試也沒用
    error.permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429 &&
      response.status !== 408;

    if (response.status === 429) {
      try {
        const wait = Number(JSON.parse(body).retry_after);

        if (Number.isFinite(wait) && wait > 0) {
          error.retryAfterMs = Math.ceil(wait * 1000);
        }
      } catch {
        // retry_after 解析失敗就用預設等待時間
      }
    }

    throw error;
  }
}


// =========================================================
// 提醒最終失敗時通知維護者（選用）
//
// 需要設定 OPS_ALERT_URL 與 OPS_ALERT_KEY，
// 沒設定就只寫入 Workers 日誌，不影響提醒本身。
// =========================================================

async function notifyOps(env, failure) {

  console.error(
    "Discord reminder FAILED permanently:",
    failure.bossName,
    failure.label,
    failure.error
  );

  if (!env.OPS_ALERT_URL || !env.OPS_ALERT_KEY) {
    return;
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `reminder:${failure.bossName}:${failure.label}:${failure.respawnAt}`
      )
    )
  );

  const h = [...digest]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

  const retryKey =
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;

  await fetch(
    env.OPS_ALERT_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPS_ALERT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "production",
        kind: "alert",
        message:
          `Discord 提醒未送出：${failure.bossName}（${failure.label}前）`,
        retryKey,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
}


// =========================================================
// Durable Object
// =========================================================

export class BossReminder extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
  }


  // =======================================================
  // 建立 BOSS 提醒
  // =======================================================

  async schedule(data) {

    const {
      chatId,
      bossKey,
      bossName,
      respawnAt,
    } = data;


    // -------------------------------------------------------
    // 基本資料檢查
    // -------------------------------------------------------

    if (
      !chatId ||
      !bossKey ||
      !bossName ||
      !respawnAt
    ) {

      return {
        ok: false,
        error: "missing fields",
      };
    }


    // -------------------------------------------------------
    // LINE 群組 → Discord 頻道綁定
    //
    // 目前只開放第一個 LINE 群組
    // 其他群組不建立 Discord 提醒
    // -------------------------------------------------------

    if (
      !this.env.DISCORD_LINE_CHAT_ID ||
      chatId !== this.env.DISCORD_LINE_CHAT_ID
    ) {

      console.log(
        "Discord reminder skipped - unmapped LINE group:",
        chatId
      );

      return {
        ok: true,
        skipped: true,
        reason: "unmapped LINE group",
      };
    }


    // -------------------------------------------------------
    // 重生時間
    // -------------------------------------------------------

    const respawnMs =
      Date.parse(respawnAt);


    if (!Number.isFinite(respawnMs)) {

      return {
        ok: false,
        error: "invalid respawnAt",
      };
    }


    // -------------------------------------------------------
    // 建立排程
    // -------------------------------------------------------

    const job = {

      // version 3
      // Discord + LINE 群組綁定版本
      version: 3,

      chatId,
      bossKey,
      bossName,

      respawnAt:
        new Date(respawnMs).toISOString(),

      pending: REMINDERS

        .map((r) => ({
          ...r,
          at: respawnMs - r.beforeMs,
        }))

        .filter(
          (r) => r.at > Date.now()
        ),
    };


    await this.ctx.storage.put(
      "job",
      job
    );


    await this.setNextAlarm(job);


    console.log(
      "Discord reminder scheduled:",
      bossName,
      chatId,
      job.pending.length
    );


    return {
      ok: true,
      version: 3,
      destination: "discord",
      pending: job.pending.length,
    };
  }


  // =======================================================
  // 取消單一 BOSS
  // =======================================================

  async cancel() {

    await this.ctx.storage.delete(
      "job"
    );

    await this.ctx.storage.deleteAlarm();


    return {
      ok: true,
    };
  }


  // =======================================================
  // 設定下一個 Alarm
  // =======================================================

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


  // =======================================================
  // Alarm 到時間
  // =======================================================

  async alarm(alarmInfo) {

    const job =
      await this.ctx.storage.get(
        "job"
      );


    if (!job) {
      return;
    }


    // -------------------------------------------------------
    // 舊 LINE 排程保護
    // -------------------------------------------------------

    if (
      job.version !== 2 &&
      job.version !== 3
    ) {

      console.log(
        "Old LINE reminder skipped:",
        job.bossName
      );


      await this.ctx.storage.delete(
        "job"
      );

      await this.ctx.storage.deleteAlarm();


      return;
    }


    // -------------------------------------------------------
    // 再次確認 LINE 群組
    //
    // 防止以前建立的 Discord v2 排程
    // 被送到錯誤 Discord 頻道
    // -------------------------------------------------------

    if (
      !this.env.DISCORD_LINE_CHAT_ID ||
      job.chatId !==
        this.env.DISCORD_LINE_CHAT_ID
    ) {

      console.log(
        "Discord reminder skipped - LINE group not mapped:",
        job.chatId
      );


      await this.ctx.storage.delete(
        "job"
      );

      await this.ctx.storage.deleteAlarm();


      return;
    }


    // -------------------------------------------------------
    // 發送 Discord 提醒
    //
    // 已重生的不發、過時的不發、每發一則就存檔，
    // 失敗會重試，最後仍失敗才放棄並通知。
    // -------------------------------------------------------

    const outcome = await processAlarm({

      job,

      send: (text) =>
        discordPush(
          this.env.DISCORD_WEBHOOK_URL,
          text
        ),

      persist: (next) =>
        this.ctx.storage.put(
          "job",
          next
        ),

      notify: (failure) =>
        notifyOps(
          this.env,
          failure
        ),

      isLastRetry:
        (alarmInfo?.retryCount ?? 0) >=
        LAST_RETRY_COUNT,
    });


    for (const item of outcome.sent) {

      console.log(
        "Discord reminder sent:",
        job.bossName,
        item.label
      );
    }

    for (const item of outcome.skipped) {

      console.log(
        "Discord reminder skipped:",
        job.bossName,
        item.label,
        item.reason
      );
    }


    // 交給 Cloudflare 稍後重試這個 alarm（已發送的不會重複）
    if (outcome.retry) {

      throw new Error(
        "Discord reminder delivery failed; alarm will retry"
      );
    }


    // -------------------------------------------------------
    // 設定下一個提醒
    // -------------------------------------------------------

    if (job.pending.length) {

      await this.setNextAlarm(
        job
      );

    } else {

      await this.ctx.storage.delete(
        "job"
      );


      await this.ctx.storage.deleteAlarm();
    }
  }
}


// =========================================================
// Worker API
// =========================================================

export default {

  async fetch(request, env) {


    // -------------------------------------------------------
    // 健康檢查
    // -------------------------------------------------------

    if (
      request.method === "GET"
    ) {

      return json({
        ok: true,
        service:
          "hit2-boss-reminder",

        destination:
          "discord",

        version:
          3,

        groupMapping:
          true,
      });
    }


    // -------------------------------------------------------
    // API Key 驗證
    // -------------------------------------------------------

    if (
      !authorized(
        request,
        env
      )
    ) {

      return json(
        {
          ok: false,
          error:
            "unauthorized",
        },
        401
      );
    }


    const url =
      new URL(
        request.url
      );


    let body;


    try {

      body =
        await request.json();

    } catch {

      return json(
        {
          ok: false,
          error:
            "invalid json",
        },
        400
      );
    }


    const {
      chatId,
      bossKey,
    } = body;


    if (
      !chatId ||
      !bossKey
    ) {

      return json(
        {
          ok: false,
          error:
            "chatId and bossKey required",
        },
        400
      );
    }


    // -------------------------------------------------------
    // 每個 LINE 群組 + BOSS
    // 使用獨立 Durable Object
    // -------------------------------------------------------

    const id =
      env.BOSS_REMINDER.idFromName(
        `${chatId}:${bossKey}`
      );


    const stub =
      env.BOSS_REMINDER.get(
        id
      );


    // -------------------------------------------------------
    // 建立提醒
    // -------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/schedule"
    ) {

      return json(
        await stub.schedule(
          body
        )
      );
    }


    // -------------------------------------------------------
    // 取消提醒
    // -------------------------------------------------------

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
        error:
          "not found",
      },
      404
    );
  },
};
