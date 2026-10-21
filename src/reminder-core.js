// Pure reminder logic (no Cloudflare imports) so it can be tested without a runtime.

export const REMINDERS = [
  { beforeMs: 5 * 60 * 1000, label: "5 分鐘", icon: "🔥" },
  { beforeMs: 1 * 60 * 1000, label: "1 分鐘", icon: "🚨" },
];

// 鬧鐘晚響超過這個時間，就不再說原本的「5 分鐘後」，改用實際剩餘時間
export const ON_TIME_MS = 30 * 1000;

// 單次 alarm 內對 Discord 的嘗試次數（失敗後 Cloudflare 還會再重試 alarm）
export const SEND_ATTEMPTS = 3;

// Cloudflare 對失敗的 alarm 最多重試 6 次（retryCount 0 到 5）
export const LAST_RETRY_COUNT = 5;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// =========================================================
// 提醒文字
// =========================================================

export function remainingLabel(reminder, remainingMs, lateMs) {

  // 準時：維持原本核准過的版面與文字
  if (lateMs <= ON_TIME_MS) {
    return reminder.label;
  }

  // 晚了：改說實際剩餘時間
  if (remainingMs >= 60 * 1000) {
    return `${Math.ceil(remainingMs / 60000)} 分鐘`;
  }

  return `${Math.max(1, Math.ceil(remainingMs / 1000))} 秒`;
}


export function buildReminderText(job, reminder, nowMs) {

  const respawnMs = Date.parse(job.respawnAt);

  const label = remainingLabel(
    reminder,
    respawnMs - nowMs,
    nowMs - reminder.at
  );

  const time = new Intl.DateTimeFormat(
    "zh-TW",
    {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }
  ).format(new Date(respawnMs));

  return (
    `${reminder.icon} **BOSS 出現提醒**\n` +
    `**${job.bossName}** 即將於 **${label}後**出現\n` +
    `⏰ 出現時間：**${time}**`
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
// 1. 王已經重生就不發
// 2. 同時到期的多則提醒只發最後一則（前面的已過時）
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

  const respawnMs = Date.parse(job.respawnAt);

  const startedAt = now();

  const due = job.pending
    .filter((r) => r.at <= startedAt + 3000)
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

  for (let i = 0; i < due.length; i++) {

    const reminder = due[i];

    const current = now();

    // 已經重生
    if (respawnMs - current <= 0) {

      // 先前發送失敗、重試到王都重生了還沒送出去：不能悄悄放棄
      const earlier = job.failed?.[reminder.at];

      if (earlier) {

        await reportFailure(reminder, earlier, "expired-while-retrying");

      } else {

        result.skipped.push({
          label: reminder.label,
          reason: "respawned",
        });
      }

      await drop(reminder);

      continue;
    }

    // 後面還有更接近的提醒，這則已過時
    if (i < due.length - 1) {

      result.skipped.push({
        label: reminder.label,
        reason: "superseded",
      });

      await drop(reminder);

      continue;
    }

    const text = buildReminderText(job, reminder, current);

    const outcome = await sendWithRetry(
      send,
      text,
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
