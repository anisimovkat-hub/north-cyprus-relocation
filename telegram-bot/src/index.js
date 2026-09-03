import { dbAll, dbBatch, dbFirst, dbRun } from "./db.js";
import { captureSource, isSharedStatsLocation, isStatsLocation, recordStart, resolveStart, statsCallback, statsCommand, trackedPayload } from "./analytics.js";
import { guideButtonText, welcomeText } from "./messages.js";
import { isBlockedError, telegram } from "./telegram.js";
import {
  compactError,
  fullName,
  isGuideKey,
  isHttpsUrl,
  keyboard,
  parseIdList,
  parseJson,
  parseScheduleInput,
  retryAt,
  topicTitle,
  validateGuide,
} from "./utils.js";

const SETTING_KEYS = new Set([
  "channel_id",
  "channel_invite_url",
  "support_chat_id",
  "support_reply_user_ids",
  "consultation_url",
  "project_prefix",
]);

function commandFrom(text = "") {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return "";
  return (trimmed.split(/\s+/, 1)[0] || "").split("@")[0].toLowerCase();
}

function commandArg(text = "") {
  return text.trim().replace(/^\/\S+\s*/, "").trim();
}

function nowSql() {
  return new Date().toISOString().replace("T", " ").replace(".000Z", "");
}

function futureSql(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").replace(".000Z", "");
}

async function loadConfig(env) {
  const rows = await dbAll(env, "SELECT setting_key, setting_value FROM settings");
  const settings = Object.fromEntries(rows.results.map((row) => [row.setting_key, row.setting_value]));
  return {
    botUsername: env.BOT_USERNAME || "zapasnoy_aerodrom_bot",
    owners: parseIdList(env.OWNER_USER_IDS),
    supportReplyIds: parseIdList(settings.support_reply_user_ids ?? env.SUPPORT_REPLY_USER_IDS),
    channelId: settings.channel_id || env.CHANNEL_ID || "",
    channelInviteUrl: settings.channel_invite_url || env.CHANNEL_INVITE_URL || "",
    supportChatId: settings.support_chat_id || env.SUPPORT_CHAT_ID || "",
    statsChatId: settings.stats_chat_id || "",
    statsTopicId: settings.stats_topic_id || "",
    consultationUrl: settings.consultation_url || env.CONSULTATION_URL || "https://zapasnoy-aerodrom.com",
    projectPrefix: settings.project_prefix || env.PROJECT_PREFIX || "ЗАПАСНОЙ АЭРОДРОМ",
    defaultTimeOffset: env.DEFAULT_TIME_OFFSET || "+03:00",
    timezoneLabel: env.DEFAULT_TIMEZONE_LABEL || "МСК",
  };
}

function isOwner(config, userId) {
  return config.owners.has(String(userId));
}

function canReply(config, userId) {
  return config.supportReplyIds.has(String(userId));
}

async function ensureUser(env, from) {
  if (!from || from.is_bot) return;
  await dbRun(
    env,
    `INSERT INTO users (user_id, first_name, last_name, username, active)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(user_id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       username = excluded.username,
       active = 1,
       last_seen_at = CURRENT_TIMESTAMP`,
    [String(from.id), from.first_name || null, from.last_name || null, from.username || null],
  );
}

async function getGuide(env, guideKey) {
  return dbFirst(env, "SELECT * FROM guides WHERE guide_key = ? AND active = 1", [guideKey]);
}

async function listGuides(env) {
  const result = await dbAll(env, "SELECT * FROM guides WHERE active = 1 ORDER BY title");
  return result.results;
}

async function setSetting(env, key, value, ownerId) {
  if (!SETTING_KEYS.has(key)) throw new Error("Настройка не разрешена");
  await dbRun(
    env,
    `INSERT INTO settings (setting_key, setting_value, updated_by, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(setting_key) DO UPDATE SET
       setting_value = excluded.setting_value,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
    [key, value, String(ownerId)],
  );
}

async function queueUpdate(env, update) {
  if (!Number.isInteger(update?.update_id)) throw new Error("Missing update_id");
  await dbRun(
    env,
    `INSERT OR IGNORE INTO incoming_updates (update_id, payload_json, status)
     VALUES (?, ?, 'pending')`,
    [String(update.update_id), JSON.stringify(update)],
  );
}

async function claimRows(env, selectSql, selectParams, updateSql, limit) {
  const candidates = await dbAll(env, `${selectSql} LIMIT ?`, [...selectParams, limit]);
  const claimed = [];
  for (const row of candidates.results) {
    const result = await dbRun(env, updateSql, [row.id ?? row.update_id]);
    if (Number(result.meta?.changes || 0) === 1) claimed.push(row);
  }
  return claimed;
}

async function processIncomingUpdates(env, limit = 20) {
  const rows = await claimRows(
    env,
    `SELECT update_id, payload_json, attempts
     FROM incoming_updates
     WHERE status IN ('pending', 'retry')
       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
       AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
     ORDER BY received_at`,
    [],
    `UPDATE incoming_updates
     SET status = 'processing', lease_until = datetime('now', '+2 minutes')
     WHERE update_id = ?
       AND status IN ('pending', 'retry')
       AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)`,
    limit,
  );

  for (const row of rows) {
    try {
      const update = JSON.parse(row.payload_json);
      await handleUpdate(env, update);
      await dbRun(
        env,
        `UPDATE incoming_updates
         SET status = 'done', processed_at = CURRENT_TIMESTAMP, lease_until = NULL, last_error = NULL
         WHERE update_id = ?`,
        [row.update_id],
      );
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const final = attempts >= 8;
      await dbRun(
        env,
        `UPDATE incoming_updates
         SET status = ?, attempts = ?, next_attempt_at = ?, lease_until = NULL, last_error = ?
         WHERE update_id = ?`,
        [final ? "failed" : "retry", attempts, final ? null : retryAt(attempts, 10, 900), compactError(error), row.update_id],
      );
    }
  }
}

async function isSubscribed(env, config, userId) {
  if (!config.channelId) return false;
  const member = await telegram(env, "getChatMember", { chat_id: config.channelId, user_id: userId });
  return ["creator", "administrator", "member"].includes(member.status)
    || (member.status === "restricted" && member.is_member === true);
}

async function promptSubscription(env, config, chatId, guide) {
  const rows = [];
  if (config.channelInviteUrl) rows.push([{ text: "Подписаться на канал", url: config.channelInviteUrl }]);
  rows.push([{ text: "Проверить подписку", callback_data: `check:${guide.guide_key}` }]);
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: `Чтобы забрать гайд «${guide.title}», пожалуйста, подпишитесь на наш канал. После подписки вернитесь сюда и нажмите «Проверить подписку».`,
    reply_markup: keyboard(rows),
  });
}

async function recordActivation(env, guideKey, userId) {
  const result = await dbRun(
    env,
    "INSERT OR IGNORE INTO activations (guide_key, user_id) VALUES (?, ?)",
    [guideKey, String(userId)],
  );
  return Number(result.meta?.changes || 0) === 1;
}

async function deliveryCount(env, guideKey) {
  const row = await dbFirst(
    env,
    "SELECT COUNT(*) AS total FROM deliveries WHERE guide_key = ? AND status = 'sent'",
    [guideKey],
  );
  return Number(row?.total || 0);
}

function guideButton(config, guideKey, count) {
  return {
    text: guideButtonText(count),
    url: `https://t.me/${config.botUsername}?start=${trackedPayload(guideKey, 'channel')}`,
  };
}

async function refreshGuideButtons(env, config, guideKey) {
  const posts = await dbAll(env, "SELECT chat_id, message_id FROM published_posts WHERE guide_key = ?", [guideKey]);
  const count = await deliveryCount(env, guideKey);
  for (const post of posts.results) {
    try {
      await telegram(env, "editMessageReplyMarkup", {
        chat_id: post.chat_id,
        message_id: post.message_id,
        reply_markup: keyboard([[guideButton(config, guideKey, count)]]),
      });
    } catch (error) {
      console.log(`counter_refresh_failed guide=${guideKey} message=${post.message_id} error=${compactError(error)}`);
    }
  }
}

async function ensureTopic(env, config, from) {
  if (!config.supportChatId || !from?.id) return null;
  const existing = await dbFirst(env, "SELECT topic_id FROM user_topics WHERE user_id = ?", [String(from.id)]);
  if (existing) return Number(existing.topic_id);

  const topic = await telegram(env, "createForumTopic", {
    chat_id: config.supportChatId,
    name: topicTitle(config.projectPrefix, from),
  });
  await dbRun(
    env,
    `INSERT OR IGNORE INTO user_topics (user_id, support_chat_id, topic_id)
     VALUES (?, ?, ?)`,
    [String(from.id), String(config.supportChatId), Number(topic.message_thread_id)],
  );
  const saved = await dbFirst(env, "SELECT topic_id FROM user_topics WHERE user_id = ?", [String(from.id)]);
  const topicId = Number(saved?.topic_id || topic.message_thread_id);
  await telegram(env, "sendMessage", {
    chat_id: config.supportChatId,
    message_thread_id: topicId,
    text: `👤 ${fullName(from)}${from.username ? ` @${from.username}` : ""}\nTelegram ID: ${from.id}\n\nТема принадлежит боту @${config.botUsername}. Только участники из SUPPORT_REPLY_USER_IDS могут отвечать лиду отсюда.`,
  }).catch(() => {});
  return topicId;
}

async function notifyTopic(env, config, from, text) {
  if (!config.supportChatId) return;
  try {
    const topicId = await ensureTopic(env, config, from);
    if (!topicId) return;
    await telegram(env, "sendMessage", {
      chat_id: config.supportChatId,
      message_thread_id: topicId,
      text,
    });
  } catch (error) {
    console.log(`topic_notification_failed user=${from.id} error=${compactError(error)}`);
  }
}

async function queueGuideFollowup(env, guide, userId) {
  const delay = Number(guide.followup_delay_minutes || 0);
  if (!guide.followup_text || delay < 1) return;
  await dbRun(
    env,
    `INSERT OR IGNORE INTO followups
       (user_id, guide_key, kind, body_text, button_text, button_url, send_at)
     VALUES (?, ?, 'followup', ?, ?, ?, ?)`,
    [String(userId), guide.guide_key, guide.followup_text, guide.followup_button_text || null, guide.followup_url || null, futureSql(delay)],
  );
}

async function queueConsultationRetry(env, config, guide, userId) {
  const body = guide.consultation_text || "Если нужна персональная консультация, запишитесь на сайте «Запасного аэродрома».";
  const url = guide.consultation_url || config.consultationUrl;
  await dbRun(
    env,
    `INSERT OR IGNORE INTO followups
       (user_id, guide_key, kind, body_text, button_text, button_url, send_at)
     VALUES (?, ?, 'consultation', ?, ?, ?, CURRENT_TIMESTAMP)`,
    [String(userId), guide.guide_key, body, guide.consultation_button_text || "Записаться на консультацию", url || null],
  );
}

async function sendConsultation(env, config, guide, userId) {
  const url = guide.consultation_url || config.consultationUrl;
  const replyMarkup = url
    ? keyboard([[{ text: guide.consultation_button_text || "Записаться на консультацию", url }]])
    : undefined;
  await telegram(env, "sendMessage", {
    chat_id: userId,
    text: guide.consultation_text || "Если нужна персональная консультация, запишитесь на сайте «Запасного аэродрома».",
    reply_markup: replyMarkup,
  });
}

async function reserveDelivery(env, guideKey, userId) {
  const inserted = await dbRun(
    env,
    `INSERT OR IGNORE INTO deliveries (guide_key, user_id, status, attempts, updated_at)
     VALUES (?, ?, 'processing', 0, CURRENT_TIMESTAMP)`,
    [guideKey, String(userId)],
  );
  if (Number(inserted.meta?.changes || 0) === 1) return "claimed";
  const current = await dbFirst(env, "SELECT status, updated_at FROM deliveries WHERE guide_key = ? AND user_id = ?", [guideKey, String(userId)]);
  if (current?.status === "sent") return "sent";
  const claimed = await dbRun(
    env,
    `UPDATE deliveries
     SET status = 'processing', updated_at = CURRENT_TIMESTAMP, next_attempt_at = NULL
     WHERE guide_key = ? AND user_id = ?
       AND (status = 'retry' OR (status = 'processing' AND updated_at <= datetime('now', '-2 minutes')))`,
    [guideKey, String(userId)],
  );
  return Number(claimed.meta?.changes || 0) === 1 ? "claimed" : "busy";
}

async function deliverGuide(env, config, from, guide, { interactive = true } = {}) {
  const userId = String(from.id);
  const reservation = await reserveDelivery(env, guide.guide_key, userId);
  if (reservation === "sent") {
    if (interactive) {
      await telegram(env, "sendMessage", {
        chat_id: userId,
        text: `Гайд «${guide.title}» уже был отправлен вам выше. Повторная выдача не учитывается.`,
      });
    }
    return true;
  }
  if (reservation === "busy") {
    if (interactive) await telegram(env, "sendMessage", { chat_id: userId, text: "Гайд уже готовится к отправке. Пожалуйста, подождите немного." });
    return false;
  }

  try {
    const document = guide.document_file_id || guide.document_url;
    if (!document) throw new Error(`У гайда ${guide.guide_key} не настроен PDF`);
    await telegram(env, "sendDocument", { chat_id: userId, document });
    if (guide.delivery_text) await telegram(env, "sendMessage", { chat_id: userId, text: guide.delivery_text });
    await dbRun(
      env,
      `UPDATE deliveries
       SET status = 'sent', delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           next_attempt_at = NULL, last_error = NULL
       WHERE guide_key = ? AND user_id = ?`,
      [guide.guide_key, userId],
    );
    try {
      await sendConsultation(env, config, guide, userId);
    } catch (error) {
      await queueConsultationRetry(env, config, guide, userId);
    }
    await queueGuideFollowup(env, guide, userId);
    await refreshGuideButtons(env, config, guide.guide_key);
    await notifyTopic(env, config, from, `🎁 Получил(а) гайд «${guide.title}».`);
    return true;
  } catch (error) {
    const row = await dbFirst(env, "SELECT attempts FROM deliveries WHERE guide_key = ? AND user_id = ?", [guide.guide_key, userId]);
    const attempts = Number(row?.attempts || 0) + 1;
    const blocked = isBlockedError(error);
    await dbRun(
      env,
      `UPDATE deliveries
       SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP, last_error = ?
       WHERE guide_key = ? AND user_id = ?`,
      [blocked ? "failed" : "retry", attempts, blocked ? null : retryAt(attempts, 20, 1800), compactError(error), guide.guide_key, userId],
    );
    if (blocked) await dbRun(env, "UPDATE users SET active = 0 WHERE user_id = ?", [userId]);
    if (interactive && !blocked) {
      await telegram(env, "sendMessage", {
        chat_id: userId,
        text: "Telegram временно не принял файл. Бот повторит отправку автоматически; нажимать кнопку ещё раз не нужно.",
      }).catch(() => {});
    }
    return false;
  }
}

async function processDeliveryRetries(env, config, limit = 10) {
  const due = await dbAll(
    env,
    `SELECT d.guide_key, d.user_id, u.first_name, u.last_name, u.username
     FROM deliveries d
     JOIN users u ON u.user_id = d.user_id
     WHERE (d.status = 'retry' AND d.next_attempt_at <= CURRENT_TIMESTAMP)
        OR (d.status = 'processing' AND d.updated_at <= datetime('now', '-2 minutes'))
     ORDER BY COALESCE(d.next_attempt_at, d.updated_at) LIMIT ?`,
    [limit],
  );
  for (const row of due.results) {
    const guide = await getGuide(env, row.guide_key);
    if (!guide) {
      await dbRun(env, "UPDATE deliveries SET status = 'failed', last_error = 'Guide disabled or missing' WHERE guide_key = ? AND user_id = ?", [row.guide_key, row.user_id]);
      continue;
    }
    await deliverGuide(env, config, {
      id: row.user_id,
      first_name: row.first_name,
      last_name: row.last_name,
      username: row.username,
    }, guide, { interactive: false });
  }
}

async function publishGuide(env, config, guide, scheduledPostId = null) {
  if (!config.channelId) throw new Error("CHANNEL_ID не настроен");
  const count = await deliveryCount(env, guide.guide_key);
  const replyMarkup = keyboard([[guideButton(config, guide.guide_key, count)]]);
  const text = guide.post_text || `Заберите гайд «${guide.title}» по кнопке ниже.`;
  const common = { chat_id: config.channelId, reply_markup: replyMarkup };
  const message = guide.post_image_file_id
    ? await telegram(env, "sendPhoto", {
      ...common,
      photo: guide.post_image_file_id,
      caption: text,
      parse_mode: guide.post_parse_mode || "HTML",
    })
    : await telegram(env, "sendMessage", {
      ...common,
      text,
      parse_mode: guide.post_parse_mode || "HTML",
    });
  await dbRun(
    env,
    `INSERT OR IGNORE INTO published_posts
       (guide_key, chat_id, message_id, scheduled_post_id)
     VALUES (?, ?, ?, ?)`,
    [guide.guide_key, String(message.chat.id), Number(message.message_id), scheduledPostId],
  );
  return message;
}

async function adminMenu(env, config, chatId) {
  const guides = await listGuides(env);
  const rows = [[{ text: "📊 Полная статистика", callback_data: "admin:stats" }]];
  for (const guide of guides) {
    rows.push([
      { text: `📣 ${guide.title}`, callback_data: `admin:publish:${guide.guide_key}` },
      { text: "🕒", callback_data: `admin:schedule:${guide.guide_key}` },
    ]);
  }
  rows.push([{ text: "➕ Добавить/обновить гайд", callback_data: "admin:guide" }]);
  rows.push([{ text: "📨 Безопасная рассылка", callback_data: "admin:broadcast" }]);
  rows.push([{ text: "⚙️ Настройки и права", callback_data: "admin:settings" }]);
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: guides.length
      ? "Админ-меню. Публикация и рассылка всегда требуют отдельного подтверждения."
      : "Админ-меню. Сначала добавьте хотя бы один гайд.",
    reply_markup: keyboard(rows),
  });
}

async function setPending(env, chatId, userId, action, payload = null) {
  await dbRun(
    env,
    `INSERT INTO pending_actions (chat_id, user_id, action, payload_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now', '+30 minutes'))
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       action = excluded.action,
       payload_json = excluded.payload_json,
       created_at = CURRENT_TIMESTAMP,
       expires_at = datetime('now', '+30 minutes')`,
    [String(chatId), String(userId), action, payload ? JSON.stringify(payload) : null],
  );
}

async function clearPending(env, chatId, userId) {
  await dbRun(env, "DELETE FROM pending_actions WHERE chat_id = ? AND user_id = ?", [String(chatId), String(userId)]);
}

async function upsertGuide(env, input) {
  await dbRun(
    env,
    `INSERT INTO guides (
       guide_key, title, document_file_id, document_url, delivery_text,
       post_text, post_image_file_id, post_parse_mode,
       consultation_text, consultation_button_text, consultation_url,
       followup_text, followup_button_text, followup_url, followup_delay_minutes,
       active, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(guide_key) DO UPDATE SET
       title = excluded.title,
       document_file_id = excluded.document_file_id,
       document_url = excluded.document_url,
       delivery_text = excluded.delivery_text,
       post_text = excluded.post_text,
       post_image_file_id = excluded.post_image_file_id,
       post_parse_mode = excluded.post_parse_mode,
       consultation_text = excluded.consultation_text,
       consultation_button_text = excluded.consultation_button_text,
       consultation_url = excluded.consultation_url,
       followup_text = excluded.followup_text,
       followup_button_text = excluded.followup_button_text,
       followup_url = excluded.followup_url,
       followup_delay_minutes = excluded.followup_delay_minutes,
       active = excluded.active,
       updated_at = CURRENT_TIMESTAMP`,
    [
      input.guide_key,
      String(input.title).trim(),
      input.document_file_id || null,
      input.document_url || null,
      input.delivery_text || null,
      input.post_text || null,
      input.post_image_file_id || null,
      input.post_parse_mode || "HTML",
      input.consultation_text || null,
      input.consultation_button_text || null,
      input.consultation_url || null,
      input.followup_text || null,
      input.followup_button_text || null,
      input.followup_url || null,
      Number.isFinite(Number(input.followup_delay_minutes)) ? Number(input.followup_delay_minutes) : null,
      input.active === false ? 0 : 1,
    ],
  );
}

async function createScheduleDraft(env, config, message, guideKey, publishAt) {
  const result = await dbRun(
    env,
    `INSERT INTO scheduled_posts (guide_key, publish_at, status, created_by)
     VALUES (?, ?, 'draft', ?)`,
    [guideKey, publishAt, String(message.from.id)],
  );
  const id = Number(result.meta?.last_row_id);
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `Запланировать публикацию гайда ${guideKey} на ${publishAt} UTC?`,
    reply_markup: keyboard([[
      { text: "✅ Подтвердить", callback_data: `sched:go:${id}` },
      { text: "✖️ Отмена", callback_data: `sched:no:${id}` },
    ]]),
  });
}

async function createBroadcastDraft(env, message) {
  const draftKey = `${message.from.id}:${message.chat.id}:${message.message_id}`;
  await dbRun(
    env,
    `INSERT OR IGNORE INTO broadcasts
       (draft_key, created_by, source_chat_id, source_message_id, body_text, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
    [draftKey, String(message.from.id), String(message.chat.id), Number(message.message_id), message.text || null],
  );
  const broadcast = await dbFirst(env, "SELECT id FROM broadcasts WHERE draft_key = ?", [draftKey]);
  const count = await dbFirst(env, "SELECT COUNT(*) AS total FROM users WHERE active = 1");
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `Разослать это сообщение ${Number(count?.total || 0)} активным пользователям? После подтверждения отправка пойдёт небольшими партиями.`,
    reply_markup: keyboard([[
      { text: "✅ Подтвердить рассылку", callback_data: `bcast:go:${broadcast.id}` },
      { text: "✖️ Отмена", callback_data: `bcast:no:${broadcast.id}` },
    ]]),
  });
}

async function capturePending(env, config, message) {
  const pending = await dbFirst(
    env,
    `SELECT action, payload_json FROM pending_actions
     WHERE chat_id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP`,
    [String(message.chat.id), String(message.from.id)],
  );
  if (!pending || commandFrom(message.text)) return false;
  const payload = parseJson(pending.payload_json, {});

  if (pending.action === "schedule") {
    const publishAt = parseScheduleInput(message.text, config.defaultTimeOffset);
    if (!publishAt || new Date(`${publishAt.replace(" ", "T")}Z`).getTime() <= Date.now()) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `Не понял дату. Пришлите будущее время в формате 2026-08-30 12:00. Без смещения используется ${config.timezoneLabel} (${config.defaultTimeOffset}).`,
      });
      return true;
    }
    await clearPending(env, message.chat.id, message.from.id);
    await createScheduleDraft(env, config, message, payload.guide_key, publishAt);
    return true;
  }

  if (pending.action === "broadcast") {
    await clearPending(env, message.chat.id, message.from.id);
    await createBroadcastDraft(env, message);
    return true;
  }

  if (pending.action === "guide_json") {
    const input = parseJson(message.text);
    const validationError = validateGuide(input);
    if (validationError) {
      await telegram(env, "sendMessage", { chat_id: message.chat.id, text: `Гайд не сохранён: ${validationError}` });
      return true;
    }
    await upsertGuide(env, input);
    await clearPending(env, message.chat.id, message.from.id);
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: `Гайд «${input.title}» [${input.guide_key}] сохранён. Публикация не запускалась.` });
    return true;
  }
  return false;
}

async function sendGuideExample(env, chatId) {
  const example = {
    guide_key: "guide_1",
    title: "Название гайда",
    document_file_id: "TELEGRAM_FILE_ID",
    delivery_text: "Ваш гайд готов.",
    post_text: "<b>Текст поста</b>",
    post_image_file_id: "TELEGRAM_PHOTO_FILE_ID",
    consultation_text: "Запишитесь на консультацию.",
    consultation_button_text: "Записаться",
    consultation_url: "https://zapasnoy-aerodrom.com",
    followup_text: "Необязательный follow-up.",
    followup_delay_minutes: 180,
  };
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: `Следующим сообщением пришлите JSON такого вида:\n\n${JSON.stringify(example, null, 2)}\n\nЧтобы узнать file_id, ответьте командой /fileid на загруженный PDF или фотографию.`,
  });
}

async function showSettings(env, config, chatId) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: [
      "⚙️ Настройки",
      `Канал: ${config.channelId || "не задан"}`,
      `Ссылка канала: ${config.channelInviteUrl || "не задана"}`,
      `Форум-группа: ${config.supportChatId || "не задана"}`,
      `ID с правом ответа: ${[...config.supportReplyIds].join(", ") || "не заданы"}`,
      `Сайт/консультация: ${config.consultationUrl || "не задан"}`,
      `Префикс тем: ${config.projectPrefix}`,
      "",
      "Команды владельца:",
      "/setchannel -100…",
      "/setinvite https://t.me/…",
      "/setsupport -100…",
      "/setsupportids 123,456",
      "/setconsultation https://…",
      "/setprefix ЗА",
      "",
      "OWNER_USER_IDS меняется только в конфигурации Worker, не из Telegram.",
    ].join("\n"),
  });
}

async function handleOwnerCommand(env, config, message, command) {
  const chatId = message.chat.id;
  const ownerId = message.from.id;
  const arg = commandArg(message.text);
  if (command === "/admin" || command === "/menu") {
    await adminMenu(env, config, chatId);
    return true;
  }
  if (command === "/stats") {
    await statsCommand(env, config, message);
    return true;
  }
  if (command === "/cancel") {
    await clearPending(env, chatId, ownerId);
    await telegram(env, "sendMessage", { chat_id: chatId, text: "Черновик отменён." });
    return true;
  }
  if (command === "/fileid") {
    const source = message.reply_to_message || message;
    const photo = source.photo?.[source.photo.length - 1]?.file_id;
    const fileId = source.document?.file_id || photo || source.video?.file_id || null;
    await telegram(env, "sendMessage", { chat_id: chatId, text: fileId ? `file_id:\n${fileId}` : "Ответьте /fileid на сообщение с PDF, фото или видео." });
    return true;
  }
  if (command === "/guideexample") {
    await sendGuideExample(env, chatId);
    return true;
  }

  const setters = {
    "/setchannel": ["channel_id", /^-100\d+$/, "Нужен ID канала вида -100…"],
    "/setinvite": ["channel_invite_url", isHttpsUrl, "Нужна HTTPS-ссылка на канал."],
    "/setsupport": ["support_chat_id", /^-100\d+$/, "Нужен ID форум-группы вида -100…"],
    "/setsupportids": ["support_reply_user_ids", (value) => value.split(",").every((id) => /^\d+$/.test(id.trim())), "Нужны числовые Telegram ID через запятую."],
    "/setconsultation": ["consultation_url", isHttpsUrl, "Нужна HTTPS-ссылка."],
    "/setprefix": ["project_prefix", (value) => value.length >= 1 && value.length <= 40, "Префикс должен быть длиной 1–40 символов."],
  };
  if (setters[command]) {
    const [key, validator, errorText] = setters[command];
    const valid = validator instanceof RegExp ? validator.test(arg) : validator(arg);
    if (!valid) {
      await telegram(env, "sendMessage", { chat_id: chatId, text: errorText });
      return true;
    }
    await setSetting(env, key, arg, ownerId);
    await telegram(env, "sendMessage", { chat_id: chatId, text: "Настройка сохранена." });
    return true;
  }
  return false;
}

async function forwardPrivateMessage(env, config, message) {
  if (!config.supportChatId) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Сообщение получено. Канал связи с командой пока настраивается." });
    return;
  }
  try {
    const topicId = await ensureTopic(env, config, message.from);
    await telegram(env, "copyMessage", {
      chat_id: config.supportChatId,
      message_thread_id: topicId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Спасибо! Передали сообщение команде. Ответ придёт сюда." });
  } catch (error) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Не удалось передать сообщение команде. Попробуйте ещё раз чуть позже." }).catch(() => {});
    throw error;
  }
}

function isServiceMessage(message) {
  return Boolean(
    message.forum_topic_created
    || message.forum_topic_edited
    || message.forum_topic_closed
    || message.forum_topic_reopened
    || message.new_chat_members
    || message.left_chat_member,
  );
}

async function relayFromTeam(env, config, message) {
  if (!config.supportChatId || String(message.chat.id) !== String(config.supportChatId)) return false;
  if (isServiceMessage(message) || !message.message_thread_id) return false;
  const mapping = await dbFirst(
    env,
    "SELECT user_id FROM user_topics WHERE support_chat_id = ? AND topic_id = ?",
    [String(config.supportChatId), Number(message.message_thread_id)],
  );
  if (!mapping) return false;
  if (message.from?.is_bot) return true;
  if ((message.text || "").startsWith("/")) return true;
  if (!message.from?.id || !canReply(config, message.from.id)) {
    await telegram(env, "sendMessage", {
      chat_id: config.supportChatId,
      message_thread_id: message.message_thread_id,
      text: `⛔ Сообщение не отправлено: Telegram ID ${message.from?.id || "не определён"} отсутствует в SUPPORT_REPLY_USER_IDS.`,
    });
    return true;
  }
  try {
    await telegram(env, "copyMessage", {
      chat_id: mapping.user_id,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
    await telegram(env, "sendMessage", {
      chat_id: config.supportChatId,
      message_thread_id: message.message_thread_id,
      text: "✓ Ответ отправлен пользователю.",
    });
  } catch (error) {
    if (isBlockedError(error)) await dbRun(env, "UPDATE users SET active = 0 WHERE user_id = ?", [mapping.user_id]);
    await telegram(env, "sendMessage", {
      chat_id: config.supportChatId,
      message_thread_id: message.message_thread_id,
      text: `⚠️ Не доставлено пользователю. ${isBlockedError(error) ? "Пользователь заблокировал бота или удалил чат." : compactError(error)}`,
    }).catch(() => {});
  }
  return true;
}

async function handleStart(env, config, message) {
  const raw = message.text.trim().split(/\s+/, 2)[1] || '';
  const attribution = await resolveStart(env, raw);
  await recordStart(env, message, attribution);
  const guideKey = attribution.guideKey;
  if (!guideKey) {
    const rows = [];
    if (config.channelInviteUrl) rows.push([{ text: 'Перейти в канал', url: config.channelInviteUrl }]);
    if (config.consultationUrl) rows.push([{ text: 'Узнать о переезде', url: config.consultationUrl }]);
    if (isOwner(config, message.from.id)) rows.push([{text:'📊 Статистика бота',callback_data:'st:overview:a'}]);
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: raw ? 'Этот гайд пока недоступен. Откройте актуальную ссылку из канала.' : welcomeText(), reply_markup:keyboard(rows) });
    return;
  }
  const guide = await getGuide(env, guideKey);
  if (!guide) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Этот гайд пока недоступен." });
    return;
  }
  const firstActivation = await recordActivation(env, guideKey, message.from.id);
  if (firstActivation) await notifyTopic(env, config, message.from, `🔗 Активировал(а) гайд «${guide.title}».`);
  if (!config.channelId || !config.channelInviteUrl) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Выдача гайда ещё настраивается. Попробуйте немного позже." });
    return;
  }
  if (await isSubscribed(env, config, message.from.id)) {
    await deliverGuide(env, config, message.from, guide);
  } else {
    await promptSubscription(env, config, message.chat.id, guide);
  }
}

async function handleMessage(env, message) {
  const config = await loadConfig(env);
  const addressedBot = (message.text || '').trim().match(/^\/\w+@([A-Za-z0-9_]+)/)?.[1];
  if (addressedBot && addressedBot.toLowerCase() !== config.botUsername.toLowerCase()) return;
  const command = commandFrom(message.text || "");
  if (message.chat.type === "private") await ensureUser(env, message.from);

  if (['/stats','/menu'].includes(command) || (command === '/start' && commandArg(message.text) === 'stats')) {
    if (!isOwner(config,message.from?.id) && !isSharedStatsLocation(config,message)) {
      if (isStatsLocation(config,message)) await telegram(env,'sendMessage',{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:'Статистика доступна только владельцам.'});
      return;
    }
    return statsCommand(env,config,message);
  }

  if (command === "/chatid") {
    const replied = message.reply_to_message;
    const forwardedChatId = replied?.forward_origin?.chat?.id || replied?.forward_from_chat?.id;
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: forwardedChatId
        ? `ID исходного чата: ${forwardedChatId}`
        : `ID этого чата: ${message.chat.id}`,
    });
    return;
  }
  if (command === "/userid") {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: `Ваш Telegram ID: ${message.from.id}` });
    return;
  }

  if (isOwner(config, message.from?.id) && message.chat.type === 'private') {
    if (await handleOwnerCommand(env, config, message, command)) return;
    if (await captureSource(env,config,message)) return;
    if (await capturePending(env, config, message)) return;
  } else if (message.chat.type === 'private' && ["/admin", "/menu", "/stats", "/broadcast"].includes(command)) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Эта функция доступна только владельцам из OWNER_USER_IDS." });
    return;
  }

  if (await relayFromTeam(env, config, message)) return;

  if (message.chat.type === "private" && command === "/start") {
    await handleStart(env, config, message);
    return;
  }
  if (message.chat.type === "private" && !command) {
    await forwardPrivateMessage(env, config, message);
    return;
  }
  if (message.chat.type === "private" && command) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Неизвестная команда. Чтобы получить гайд, откройте ссылку из канала." });
  }
}

async function confirmPublish(env, config, callback, guideKey) {
  const guide = await getGuide(env, guideKey);
  if (!guide) return;
  await telegram(env, "sendMessage", {
    chat_id: callback.message.chat.id,
    text: `Опубликовать «${guide.title}» в канале сейчас?`,
    reply_markup: keyboard([[
      { text: "✅ Опубликовать", callback_data: `pub:go:${guideKey}` },
      { text: "✖️ Отмена", callback_data: `pub:no:${guideKey}` },
    ]]),
  });
}

async function handleBroadcastCallback(env, config, callback, data) {
  const [, action, idRaw] = data.split(":");
  const id = Number(idRaw);
  const broadcast = await dbFirst(env, "SELECT * FROM broadcasts WHERE id = ?", [id]);
  if (!broadcast || String(broadcast.created_by) !== String(callback.from.id)) return;
  if (action === "no") {
    await dbRun(env, "UPDATE broadcasts SET status = 'canceled' WHERE id = ? AND status = 'draft'", [id]);
    await telegram(env, "editMessageText", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: "Рассылка отменена." });
    return;
  }
  if (action === "stop") {
    await dbBatch(env, [
      env.DB.prepare("UPDATE broadcasts SET status = 'canceled', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('confirmed', 'sending')").bind(id),
      env.DB.prepare("UPDATE broadcast_recipients SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE broadcast_id = ? AND status IN ('pending', 'processing')").bind(id),
    ]);
    await telegram(env, "editMessageText", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: "Рассылка остановлена. Уже отправленные сообщения отозвать нельзя." });
    return;
  }
  if (action !== "go" || broadcast.status !== "draft") return;
  await dbRun(
    env,
    `INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, user_id)
     SELECT ?, user_id FROM users WHERE active = 1`,
    [id],
  );
  await dbRun(env, "UPDATE broadcasts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'", [id]);
  const count = await dbFirst(env, "SELECT COUNT(*) AS total FROM broadcast_recipients WHERE broadcast_id = ?", [id]);
  await telegram(env, "editMessageText", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text: `Рассылка подтверждена: ${Number(count?.total || 0)} получателей. Отправка идёт партиями.`,
    reply_markup: keyboard([[{ text: "⛔ Остановить рассылку", callback_data: `bcast:stop:${id}` }]]),
  });
}

async function handleCallback(env, callback) {
  const config = await loadConfig(env);
  const data = callback.data || "";
  const chatId = callback.message?.chat?.id;
  if (data.startsWith('st:') || data === 'admin:stats') return statsCallback(env,config,{...callback,data:data==='admin:stats'?'st:overview:a':data});

  if (data.startsWith("check:")) {
    if (callback.message?.chat?.type !== 'private' || String(chatId) !== String(callback.from.id)) return;
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
    await ensureUser(env, callback.from);
    const guideKey = data.slice("check:".length);
    const guide = await getGuide(env, guideKey);
    if (!guide) return;
    if (await isSubscribed(env, config, callback.from.id)) {
      await deliverGuide(env, config, callback.from, guide);
    } else {
      await promptSubscription(env, config, chatId, guide);
    }
    return;
  }

  if (!isOwner(config, callback.from.id) || callback.message?.chat?.type !== 'private') {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Нет прав владельца", show_alert: true }).catch(() => {});
    return;
  }
  await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});

  if (data === "admin:settings") return showSettings(env, config, chatId);
  if (data === "admin:guide") {
    await setPending(env, chatId, callback.from.id, "guide_json");
    return sendGuideExample(env, chatId);
  }
  if (data === "admin:broadcast") {
    await setPending(env, chatId, callback.from.id, "broadcast");
    return telegram(env, "sendMessage", { chat_id: chatId, text: "Пришлите следующим сообщением текст, фото, видео или документ для рассылки. Затем бот покажет обязательное подтверждение. /cancel — отмена." });
  }
  if (data.startsWith("admin:publish:")) return confirmPublish(env, config, callback, data.slice("admin:publish:".length));
  if (data.startsWith("admin:schedule:")) {
    const guideKey = data.slice("admin:schedule:".length);
    if (!await getGuide(env, guideKey)) return;
    await setPending(env, chatId, callback.from.id, "schedule", { guide_key: guideKey });
    return telegram(env, "sendMessage", {
      chat_id: chatId,
      text: `Пришлите дату и время публикации в формате 2026-08-30 12:00. По умолчанию используется ${config.timezoneLabel} (${config.defaultTimeOffset}). /cancel — отмена.`,
    });
  }
  if (data.startsWith("pub:")) {
    const [, action, guideKey] = data.split(":");
    if (action === "no") return telegram(env, "editMessageText", { chat_id: chatId, message_id: callback.message.message_id, text: "Публикация отменена." });
    if (action !== "go") return;
    const guide = await getGuide(env, guideKey);
    if (!guide) return;
    const message = await publishGuide(env, config, guide);
    return telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: `Опубликовано: «${guide.title}», message_id ${message.message_id}.`,
    });
  }
  if (data.startsWith("sched:")) {
    const [, action, idRaw] = data.split(":");
    const id = Number(idRaw);
    const row = await dbFirst(env, "SELECT * FROM scheduled_posts WHERE id = ?", [id]);
    if (!row || String(row.created_by) !== String(callback.from.id)) return;
    if (action === "no") {
      await dbRun(env, "UPDATE scheduled_posts SET status = 'canceled' WHERE id = ? AND status = 'draft'", [id]);
      return telegram(env, "editMessageText", { chat_id: chatId, message_id: callback.message.message_id, text: "Отложенная публикация отменена." });
    }
    if (action === "go") {
      await dbRun(env, "UPDATE scheduled_posts SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'", [id]);
      return telegram(env, "editMessageText", { chat_id: chatId, message_id: callback.message.message_id, text: `Публикация запланирована на ${row.publish_at} UTC.` });
    }
  }
  if (data.startsWith("bcast:")) return handleBroadcastCallback(env, config, callback, data);
}

async function processScheduledPosts(env, config, limit = 5) {
  const rows = await claimRows(
    env,
    `SELECT id, guide_key, attempts, created_by
     FROM scheduled_posts
     WHERE status IN ('pending', 'retry')
       AND publish_at <= CURRENT_TIMESTAMP
       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
       AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
     ORDER BY publish_at`,
    [],
    `UPDATE scheduled_posts
     SET status = 'processing', lease_until = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('pending', 'retry')
       AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)`,
    limit,
  );
  for (const row of rows) {
    try {
      const guide = await getGuide(env, row.guide_key);
      if (!guide) throw new Error("Гайд отсутствует или отключён");
      const message = await publishGuide(env, config, guide, row.id);
      await dbRun(
        env,
        `UPDATE scheduled_posts
         SET status = 'done', published_chat_id = ?, published_message_id = ?,
             lease_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [String(message.chat.id), Number(message.message_id), row.id],
      );
      await telegram(env, "sendMessage", { chat_id: row.created_by, text: `✅ Отложенный пост «${guide.title}» опубликован.` }).catch(() => {});
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const final = attempts >= 8;
      await dbRun(
        env,
        `UPDATE scheduled_posts
         SET status = ?, attempts = ?, next_attempt_at = ?, lease_until = NULL,
             last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [final ? "failed" : "retry", attempts, final ? null : retryAt(attempts, 30, 3600), compactError(error), row.id],
      );
      if (final) await telegram(env, "sendMessage", { chat_id: row.created_by, text: `⚠️ Отложенная публикация ${row.guide_key} не выполнена после 8 попыток: ${compactError(error)}` }).catch(() => {});
    }
  }
}

async function processBroadcasts(env, limit = 15) {
  const broadcast = await dbFirst(env, "SELECT * FROM broadcasts WHERE status IN ('confirmed', 'sending') ORDER BY id LIMIT 1");
  if (!broadcast) return;
  if (broadcast.status === "confirmed") await dbRun(env, "UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'confirmed'", [broadcast.id]);
  const candidates = await dbAll(
    env,
    `SELECT user_id, attempts FROM broadcast_recipients
     WHERE broadcast_id = ?
       AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
         OR (status = 'processing' AND updated_at <= datetime('now', '-2 minutes')))
     ORDER BY user_id LIMIT ?`,
    [broadcast.id, limit],
  );
  for (const recipient of candidates.results) {
    const latest = await dbFirst(env, "SELECT status FROM broadcasts WHERE id = ?", [broadcast.id]);
    if (latest?.status === "canceled") break;
    const claimed = await dbRun(
      env,
      `UPDATE broadcast_recipients
       SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE broadcast_id = ? AND user_id = ?
         AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
           OR (status = 'processing' AND updated_at <= datetime('now', '-2 minutes')))`,
      [broadcast.id, recipient.user_id],
    );
    if (Number(claimed.meta?.changes || 0) !== 1) continue;
    try {
      if (broadcast.source_chat_id && broadcast.source_message_id) {
        await telegram(env, "copyMessage", {
          chat_id: recipient.user_id,
          from_chat_id: broadcast.source_chat_id,
          message_id: broadcast.source_message_id,
        });
      } else {
        await telegram(env, "sendMessage", { chat_id: recipient.user_id, text: broadcast.body_text });
      }
      await dbRun(
        env,
        `UPDATE broadcast_recipients
         SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE broadcast_id = ? AND user_id = ? AND status = 'processing'`,
        [broadcast.id, recipient.user_id],
      );
    } catch (error) {
      const attempts = Number(recipient.attempts || 0) + 1;
      const permanent = isBlockedError(error) || attempts >= 5;
      await dbRun(
        env,
        `UPDATE broadcast_recipients
         SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
             , updated_at = CURRENT_TIMESTAMP
         WHERE broadcast_id = ? AND user_id = ?`,
        [permanent ? "failed" : "pending", attempts, permanent ? null : retryAt(attempts, 60, 3600), compactError(error), broadcast.id, recipient.user_id],
      );
      if (isBlockedError(error)) await dbRun(env, "UPDATE users SET active = 0 WHERE user_id = ?", [recipient.user_id]);
    }
  }
  const remaining = await dbFirst(env, "SELECT COUNT(*) AS total FROM broadcast_recipients WHERE broadcast_id = ? AND status IN ('pending', 'processing')", [broadcast.id]);
  if (Number(remaining?.total || 0) === 0) {
    const totals = await dbFirst(
      env,
      `SELECT SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed,
              SUM(status = 'canceled') AS canceled
       FROM broadcast_recipients WHERE broadcast_id = ?`,
      [broadcast.id],
    );
    await dbRun(env, "UPDATE broadcasts SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'", [broadcast.id]);
    await telegram(env, "sendMessage", {
      chat_id: broadcast.created_by,
      text: `✅ Рассылка завершена. Доставлено: ${Number(totals?.sent || 0)}, ошибок: ${Number(totals?.failed || 0)}, отменено: ${Number(totals?.canceled || 0)}.`,
    }).catch(() => {});
  }
}

async function processFollowups(env, limit = 15) {
  const due = await dbAll(
    env,
    `SELECT * FROM followups
     WHERE ((status IN ('pending', 'retry')
       AND send_at <= CURRENT_TIMESTAMP
       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
       OR (status = 'processing' AND updated_at <= datetime('now', '-2 minutes')))
     ORDER BY send_at LIMIT ?`,
    [limit],
  );
  for (const row of due.results) {
    const claimed = await dbRun(
      env,
      `UPDATE followups SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (status IN ('pending', 'retry')
         OR (status = 'processing' AND updated_at <= datetime('now', '-2 minutes')))`,
      [row.id],
    );
    if (Number(claimed.meta?.changes || 0) !== 1) continue;
    try {
      await telegram(env, "sendMessage", {
        chat_id: row.user_id,
        text: row.body_text,
        reply_markup: row.button_url ? keyboard([[{ text: row.button_text || "Перейти", url: row.button_url }]]) : undefined,
      });
      await dbRun(env, "UPDATE followups SET status = 'sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?", [row.id]);
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const permanent = isBlockedError(error) || attempts >= 6;
      await dbRun(
        env,
        `UPDATE followups
         SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
             , updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [permanent ? "failed" : "retry", attempts, permanent ? null : retryAt(attempts, 60, 3600), compactError(error), row.id],
      );
      if (isBlockedError(error)) await dbRun(env, "UPDATE users SET active = 0 WHERE user_id = ?", [row.user_id]);
    }
  }
}

async function handleUpdate(env, update) {
  if (update.message) await handleMessage(env, update.message);
  if (update.callback_query) await handleCallback(env, update.callback_query);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const config = await loadConfig(env);
      return jsonResponse({
        ok: true,
        service: "zapasnoy-aerodrom-bot",
        configured: {
          bot_token: Boolean(env.BOT_TOKEN),
          webhook_secret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
          owners: config.owners.size > 0,
          channel: Boolean(config.channelId && config.channelInviteUrl),
          support_forum: Boolean(config.supportChatId),
          support_reply_ids: config.supportReplyIds.size > 0,
          statistics: true,
          statistics_group: Boolean(config.statsChatId && config.statsTopicId),
        },
      });
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("Webhook is not configured", { status: 503 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    try {
      await queueUpdate(env, update);
    } catch (error) {
      console.log(`queue_update_failed error=${compactError(error)}`);
      return new Response("Temporary failure", { status: 503 });
    }
    ctx.waitUntil(processIncomingUpdates(env, 5));
    return new Response("OK");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await processIncomingUpdates(env, 25);
      const config = await loadConfig(env);
      await processDeliveryRetries(env, config, 10);
      await processScheduledPosts(env, config, 5);
      await processBroadcasts(env, 15);
      await processFollowups(env, 15);
    })().catch((error) => console.log(`scheduled_failed error=${compactError(error)}`)));
  },
};
