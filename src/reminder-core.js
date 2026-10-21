// Pure reminder logic (no Cloudflare imports) so it can be tested without a runtime.
//
// 每隻王只在「重生當下」發送一則 Discord 通知。

export const REMINDERS = [
  { beforeMs: 0, label: "已重生", icon: "⚔️" },
];

// 準時送出時，鬧鐘即使提早的毫秒數也會等到整點再送
export const MAX_EARLY_WAIT_MS = 3 * 1000;

// 晚超過這個時間就不補發，改通知維護者
export const MAX_LATE_MS = 5 * 60 * 1000;

// 單次 alarm 內對 Discord 的嘗試次數（失敗後 Cloudflare 還會再重試 alarm）
export const SEND_ATTEMPTS = 3;

// Cloudflare 對失敗的 alarm 最多重試 6 次（retryCount 0 到 5）
export const LAST_RETRY_COUNT = 5;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// =========================================================
// 舊資料轉換
//
// 舊版會排「重生前 5 分鐘 / 1 分鐘」兩個提醒。
// 部署後仍在排程中的舊工作，不能再發那兩種提醒，
// 只保留「重生當下」這一則。
// =========================================================

export function normalizeJob(job, nowMs = Date.now()) {

  const respawnMs = Date.parse(job.respawnAt);

  const hadLegacy = job.pending.some((r) => r.beforeMs !== 0);

  job.pending = job.pending.filter((r) => r.beforeMs === 0);

  if (
    hadLegacy &&
    !job.pending.length &&
    Number.isFinite(respawnMs) &&
    respawnMs > nowMs - MAX_LATE_MS
  ) {

    job.pending.push({
      ...REMINDERS[0],
      at: respawnMs,
    });
  }

  return job;
}


// =========================================================
// 提醒文字
//
// 一律寫出「真正的重生時間」，就算晚幾秒送出也不會誤導。
// =========================================================

export function buildReminderText(job) {

  const time = new Intl.DateTimeFormat(
    "zh-TW",
    {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }
  ).format(new Date(job.respawnAt));

  return (
    `⚔️ **${job.bossName} 已重生**\n` +
    `⏰ 重生時間：**${time}**`
  );
}


// =========================================================
// 發送（含重試）
// =========================================================

export async function sendWithRetry(
  send,
  text,
  { attempts = SEND_ATTEMPTS, sleep = defaultSleep } = {}
) {

  let lastError;

  for (let i = 1; i <= attempts; i++) {

    try {

      await send(text);

      return { ok: true };

    } catch (error) {

      lastError = error;

      // 網址失效、權限錯誤這類重試也不會好
      if (error?.permanent) {
        break;
      }

      if (i < attempts) {
        await sleep(
          Math.min(error?.retryAfterMs ?? 1000 * i, 5000)
        );
      }
    }
  }

  return { ok: false, error: lastError };
}


// =========================================================
// 處理一次 alarm
//
// 規則：
// 1. 到了重生時間才發（鬧鐘稍早會等到整點）
// 2. 晚超過 5 分鐘就不補發，改通知維護者
// 3. 每處理完一則就先存檔，重試時不會重複發送
// 4. 發送失敗：先重試，最後一次仍失敗才放棄並通知
// =========================================================

export async function processAlarm({
  job,
  now = () => Date.now(),
  send,
  persist,
  notify = async () => {},
  isLastRetry = false,
  sleep = defaultSleep,
  attempts = SEND_ATTEMPTS,
}) {

  const result = {
    sent: [],
    skipped: [],
    failed: [],
    retry: false,
  };

  normalizeJob(job, now());

  const startedAt = now();

  const due = job.pending
    .filter((r) => r.at <= startedAt + MAX_EARLY_WAIT_MS)
    .sort((a, b) => a.at - b.at);

  const drop = async (reminder) => {

    job.pending = job.pending.filter(
      (r) => r.at !== reminder.at
    );

    if (job.failed) {
      delete job.failed[reminder.at];
    }

    await persist(job);
  };

  const reportFailure = async (reminder, error, reason) => {

    result.failed.push({
      label: reminder.label,
      error,
      reason,
    });

    try {

      await notify({
        bossName: job.bossName,
        label: reminder.label,
        respawnAt: job.respawnAt,
        error,
        reason,
      });

    } catch {
      // 通知失敗不可影響其他提醒
    }
  };

  for (const reminder of due) {

    // 稍早到的鬧鐘：等到整點再發，時間才準
    const early = reminder.at - now();

    if (early > 0) {
      await sleep(early);
    }

    const lateMs = now() - reminder.at;

    // 晚太多：不補發（過時的「已重生」沒有意義），但要讓維護者知道
    if (lateMs > MAX_LATE_MS) {

      const earlier = job.failed?.[reminder.at];

      await drop(reminder);

      await reportFailure(
        reminder,
        earlier ?? `late ${Math.round(lateMs / 1000)}s`,
        earlier ? "expired-while-retrying" : "too-late"
      );

      continue;
    }

    const outcome = await sendWithRetry(
      send,
      buildReminderText(job),
      { attempts, sleep }
    );

    if (outcome.ok) {

      result.sent.push({ label: reminder.label });

      await drop(reminder);

      continue;
    }

    // 失敗：還有 alarm 重試機會就交給 Cloudflare 再試
    if (!isLastRetry && !outcome.error?.permanent) {

      result.retry = true;

      job.failed = {
        ...(job.failed ?? {}),
        [reminder.at]: String(outcome.error?.message ?? outcome.error),
      };

      await persist(job);

      break;
    }

    // 最後一次也失敗，或重試沒意義：放棄並通知
    await drop(reminder);

    await reportFailure(
      reminder,
      String(outcome.error?.message ?? outcome.error),
      "gave-up"
    );
  }

  return result;
}
