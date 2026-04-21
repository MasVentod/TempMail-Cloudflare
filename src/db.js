import {
  ADMIN_API_EXPIRES_AT,
  API_ACCESS_DAYS,
  API_CHAT_PREFIX,
  API_DAILY_QUOTA,
  getAdminIds,
  getPrimaryAdminId,
} from "./constants.js";
import {
  ApiError,
  addDays,
  addHours,
  createApiKey,
  generateAlias,
  getWibDateKey,
  isInboxActive,
} from "./utils.js";

function nowIso() {
  return new Date().toISOString();
}

function numericValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUserId(value) {
  return String(value ?? "").trim();
}

function isAdminUserId(env, value) {
  return getAdminIds(env).includes(normalizeUserId(value));
}

export function getApiChatId(userId) {
  return `${API_CHAT_PREFIX}${String(userId).trim()}`;
}

export function isApiAccessActive(access, at = new Date()) {
  if (!access || access.revoked_at) {
    return false;
  }

  if (isUnlimitedApiAccess(access)) {
    return true;
  }

  return new Date(access.expires_at).getTime() > at.getTime();
}

export function isUnlimitedApiAccess(access) {
  return Boolean(access)
    && Number(access.quota_daily) <= 0;
}

export async function ensureChatId(db, chatId, username = null) {
  const timestamp = nowIso();
  await db.prepare(`
    INSERT INTO chats (chat_id, username, first_name, last_name, language, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = COALESCE(chats.username, excluded.username),
      updated_at = excluded.updated_at
  `).bind(String(chatId), username, timestamp, timestamp).run();
}

export async function upsertChat(db, {
  chatId,
  username = null,
  firstName = null,
  lastName = null,
  language = null,
}) {
  const timestamp = nowIso();
  await db.prepare(`
    INSERT INTO chats (chat_id, username, first_name, last_name, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language = COALESCE(excluded.language, chats.language),
      updated_at = excluded.updated_at
  `).bind(
    String(chatId),
    username,
    firstName,
    lastName,
    language,
    timestamp,
    timestamp,
  ).run();
}

export async function getChat(db, chatId) {
  return db.prepare("SELECT * FROM chats WHERE chat_id = ?")
    .bind(String(chatId))
    .first();
}

export async function getInboxByAlias(db, alias) {
  return db.prepare("SELECT * FROM inboxes WHERE alias = ?")
    .bind(alias)
    .first();
}

export async function getInboxForChat(db, chatId, alias) {
  return db.prepare("SELECT * FROM inboxes WHERE chat_id = ? AND alias = ?")
    .bind(String(chatId), alias)
    .first();
}

export async function listInboxesForChat(db, chatId, limit = 25) {
  const { results = [] } = await db.prepare(`
    SELECT *
    FROM inboxes
    WHERE chat_id = ? AND is_active = 1
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(String(chatId), limit).all();
  return results;
}

export async function createInboxForChat(db, {
  chatId,
  domain,
  alias = null,
  ttlHours,
  permanent = true,
}) {
  await ensureChatId(db, chatId);

  const explicitAlias = Boolean(alias);
  let candidate = alias;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    candidate = candidate || generateAlias();
    const existing = await getInboxByAlias(db, candidate);

    if (existing && isInboxActive(existing)) {
      if (explicitAlias) {
        throw new Error("alias_taken");
      }

      candidate = null;
      continue;
    }

    if (existing) {
      await deleteInboxCascade(db, { alias: candidate });
    }

    const createdAt = nowIso();
    const expiresAt = permanent ? ADMIN_API_EXPIRES_AT : addHours(createdAt, ttlHours || 24);

    try {
      await db.prepare(`
        INSERT INTO inboxes (alias, chat_id, domain, created_at, expires_at, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).bind(candidate, String(chatId), domain, createdAt, expiresAt).run();

      return {
        alias: candidate,
        chat_id: String(chatId),
        domain,
        created_at: createdAt,
        expires_at: expiresAt,
        is_active: 1,
        last_message_at: null,
      };
    } catch (error) {
      if (explicitAlias) {
        throw error;
      }
      candidate = null;
    }
  }

  throw new Error("alias_generation_failed");
}

export async function renewInboxForChat(db, chatId, alias, _ttlHours) {
  const inbox = await getInboxForChat(db, chatId, alias);
  if (!inbox) {
    return null;
  }

  const expiresAt = ADMIN_API_EXPIRES_AT;
  await db.prepare(`
    UPDATE inboxes
    SET expires_at = ?, is_active = 1
    WHERE chat_id = ? AND alias = ?
  `).bind(expiresAt, String(chatId), alias).run();

  return {
    ...inbox,
    expires_at: expiresAt,
    is_active: 1,
  };
}

export async function deleteInboxCascade(db, { alias, chatId = null }) {
  const inbox = chatId
    ? await getInboxForChat(db, chatId, alias)
    : await getInboxByAlias(db, alias);

  if (!inbox) {
    return false;
  }

  await db.batch([
    db.prepare("DELETE FROM messages WHERE alias = ?").bind(alias),
    chatId
      ? db.prepare("DELETE FROM inboxes WHERE alias = ? AND chat_id = ?").bind(alias, String(chatId))
      : db.prepare("DELETE FROM inboxes WHERE alias = ?").bind(alias),
  ]);

  return true;
}

export async function listMessagesForInbox(db, chatId, alias, limit = 10) {
  const { results = [] } = await db.prepare(`
    SELECT id, short_id, alias, chat_id, from_address, from_name, to_address, delivered_to,
      recipient_tag, subject, snippet, raw_size, received_at
    FROM messages
    WHERE chat_id = ? AND alias = ?
    ORDER BY received_at DESC
    LIMIT ?
  `).bind(String(chatId), alias, limit).all();
  return results;
}

export async function listMessagesByAlias(db, alias, limit = 10) {
  const { results = [] } = await db.prepare(`
    SELECT id, short_id, alias, chat_id, from_address, from_name, to_address, delivered_to,
      recipient_tag, subject, snippet, raw_size, received_at
    FROM messages
    WHERE alias = ?
    ORDER BY received_at DESC
    LIMIT ?
  `).bind(alias, limit).all();
  return results;
}

export async function getMessageByShortId(db, shortId) {
  return db.prepare(`
    SELECT *
    FROM messages
    WHERE short_id = ?
    LIMIT 1
  `).bind(shortId).first();
}

export async function getMessageForChat(db, chatId, idOrShortId) {
  return db.prepare(`
    SELECT *
    FROM messages
    WHERE chat_id = ? AND (id = ? OR short_id = ?)
    LIMIT 1
  `).bind(String(chatId), idOrShortId, idOrShortId).first();
}

export async function insertMessage(db, message) {
  await db.prepare(`
    INSERT INTO messages (
      id, short_id, alias, chat_id, from_address, from_name, to_address, subject, snippet,
      text_body, html_body, raw_size, sender_message_id, headers_json, received_at,
      telegram_notified_at, delivered_to, recipient_tag
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    message.id,
    message.short_id,
    message.alias,
    message.chat_id,
    message.from_address,
    message.from_name,
    message.to_address,
    message.subject,
    message.snippet,
    message.text_body,
    message.html_body,
    message.raw_size,
    message.sender_message_id,
    message.headers_json,
    message.received_at,
    message.telegram_notified_at,
    message.delivered_to,
    message.recipient_tag,
  ).run();

  await db.prepare(`
    UPDATE inboxes
    SET last_message_at = ?
    WHERE alias = ?
  `).bind(message.received_at, message.alias).run();
}

export async function markMessageTelegramNotified(db, messageId) {
  await db.prepare(`
    UPDATE messages
    SET telegram_notified_at = ?
    WHERE id = ?
  `).bind(nowIso(), messageId).run();
}

export async function cleanupExpiredInboxes(env) {
  if (!env.DB) {
    return { deleted: 0, deactivated: 0 };
  }
  return { deleted: 0, deactivated: 0 };
}

async function ensureSingleAdminApiAccess(db, adminUserId, timestamp, quotaDate) {
  const existing = await db.prepare("SELECT * FROM api_access WHERE user_id = ?")
    .bind(adminUserId)
    .first();
  const apiKey = existing?.api_key || createApiKey();
  const grantedAt = existing?.granted_at || timestamp;
  const lastUsedAt = existing?.last_used_at || null;

  await ensureChatId(db, adminUserId);
  await ensureChatId(db, getApiChatId(adminUserId), "api-admin");

  await db.prepare(`
    INSERT INTO api_access (
      user_id, api_key, quota_daily, quota_used, quota_date, granted_by, granted_at,
      expires_at, revoked_at, last_used_at
    )
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key = COALESCE(api_access.api_key, excluded.api_key),
      quota_daily = 0,
      quota_used = 0,
      quota_date = excluded.quota_date,
      granted_by = excluded.granted_by,
      granted_at = COALESCE(api_access.granted_at, excluded.granted_at),
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      last_used_at = COALESCE(api_access.last_used_at, excluded.last_used_at)
  `).bind(
    adminUserId,
    apiKey,
    quotaDate,
    adminUserId,
    grantedAt,
    ADMIN_API_EXPIRES_AT,
    lastUsedAt,
  ).run();

  return {
    user_id: adminUserId,
    api_key: apiKey,
    quota_daily: 0,
    quota_used: 0,
    quota_date: quotaDate,
    granted_by: adminUserId,
    granted_at: grantedAt,
    expires_at: ADMIN_API_EXPIRES_AT,
    revoked_at: null,
    last_used_at: lastUsedAt,
  };
}

export async function ensureAdminApiAccess(db, env, targetUserId = getPrimaryAdminId(env)) {
  const timestamp = nowIso();
  const quotaDate = getWibDateKey();
  const adminIds = getAdminIds(env);
  const primaryAdminId = getPrimaryAdminId(env);

  if (adminIds.length === 0 || !primaryAdminId) {
    return null;
  }

  const normalizedTarget = isAdminUserId(env, targetUserId) ? normalizeUserId(targetUserId) : primaryAdminId;

  let selected = null;
  for (const adminUserId of adminIds) {
    const access = await ensureSingleAdminApiAccess(db, adminUserId, timestamp, quotaDate);
    if (adminUserId === normalizedTarget) {
      selected = access;
    }
  }

  return selected;
}

export async function grantApiAccess(db, env, {
  userId,
  grantedBy,
  days = API_ACCESS_DAYS,
  quotaDaily = API_DAILY_QUOTA,
}) {
  const normalizedUserId = normalizeUserId(userId);
  if (isAdminUserId(env, normalizedUserId)) {
    return ensureAdminApiAccess(db, env, normalizedUserId);
  }

  const normalizedDays = Math.max(1, numericValue(days, API_ACCESS_DAYS));
  const normalizedQuota = Math.max(1, numericValue(quotaDaily, API_DAILY_QUOTA));
  const timestamp = nowIso();
  const expiresAt = addDays(timestamp, normalizedDays);
  const apiKey = createApiKey();
  const quotaDate = getWibDateKey();

  await ensureChatId(db, normalizedUserId);
  await ensureChatId(db, getApiChatId(normalizedUserId), "api-user");

  await db.prepare(`
    INSERT INTO api_access (
      user_id, api_key, quota_daily, quota_used, quota_date, granted_by, granted_at,
      expires_at, revoked_at, last_used_at
    )
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key = excluded.api_key,
      quota_daily = excluded.quota_daily,
      quota_used = 0,
      quota_date = excluded.quota_date,
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at,
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      last_used_at = NULL
  `).bind(
    normalizedUserId,
    apiKey,
    normalizedQuota,
    quotaDate,
    String(grantedBy),
    timestamp,
    expiresAt,
  ).run();

  return {
    user_id: normalizedUserId,
    api_key: apiKey,
    quota_daily: normalizedQuota,
    quota_used: 0,
    quota_date: quotaDate,
    granted_by: String(grantedBy),
    granted_at: timestamp,
    expires_at: expiresAt,
    revoked_at: null,
    last_used_at: null,
  };
}

export async function revokeApiAccess(db, env, userId) {
  if (isAdminUserId(env, userId)) {
    return 0;
  }

  const result = await db.prepare(`
    UPDATE api_access
    SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(nowIso(), String(userId).trim()).run();
  return result.meta?.changes ?? 0;
}

export async function getApiAccessByUserId(db, env, userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (isAdminUserId(env, normalizedUserId)) {
    return ensureAdminApiAccess(db, env, normalizedUserId);
  }

  const access = await db.prepare("SELECT * FROM api_access WHERE user_id = ?")
    .bind(normalizedUserId)
    .first();

  if (!access) {
    return null;
  }

  if (isUnlimitedApiAccess(access)) {
    return access;
  }

  const today = getWibDateKey();
  if (access.quota_date === today) {
    return access;
  }

  await db.prepare(`
    UPDATE api_access
    SET quota_date = ?, quota_used = 0
    WHERE user_id = ?
  `).bind(today, access.user_id).run();

  return {
    ...access,
    quota_date: today,
    quota_used: 0,
  };
}

export async function listApiAccess(db, env, limit = 20) {
  await ensureAdminApiAccess(db, env);
  const { results = [] } = await db.prepare(`
    SELECT *
    FROM api_access
    ORDER BY granted_at DESC
    LIMIT ?
  `).bind(limit).all();
  return results;
}

export async function getApiWebhookByUserId(db, userId) {
  return db.prepare(`
    SELECT *
    FROM api_webhooks
    WHERE user_id = ?
      AND is_active = 1
  `).bind(String(userId).trim()).first();
}

export async function upsertApiWebhook(db, {
  userId,
  webhookUrl,
  webhookSecret = null,
}) {
  const timestamp = nowIso();
  const normalizedUserId = String(userId).trim();

  await db.prepare(`
    INSERT INTO api_webhooks (
      user_id, webhook_url, webhook_secret, is_active, created_at, updated_at
    )
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      webhook_url = excluded.webhook_url,
      webhook_secret = excluded.webhook_secret,
      is_active = 1,
      updated_at = excluded.updated_at,
      last_error = NULL
  `).bind(
    normalizedUserId,
    webhookUrl,
    webhookSecret,
    timestamp,
    timestamp,
  ).run();

  return getApiWebhookByUserId(db, normalizedUserId);
}

export async function deleteApiWebhook(db, userId) {
  const result = await db.prepare(`
    DELETE FROM api_webhooks
    WHERE user_id = ?
  `).bind(String(userId).trim()).run();
  return result.meta?.changes ?? 0;
}

export async function markApiWebhookDelivery(db, userId, {
  success,
  statusCode = null,
  error = null,
}) {
  const timestamp = nowIso();
  if (success) {
    await db.prepare(`
      UPDATE api_webhooks
      SET
        last_success_at = ?,
        last_status_code = ?,
        last_error = NULL
      WHERE user_id = ?
    `).bind(timestamp, statusCode, String(userId).trim()).run();
    return;
  }

  const errorText = error ? String(error).slice(0, 500) : null;
  await db.prepare(`
    UPDATE api_webhooks
    SET
      last_failure_at = ?,
      last_status_code = ?,
      last_error = ?
    WHERE user_id = ?
  `).bind(timestamp, statusCode, errorText, String(userId).trim()).run();
}

export async function consumeApiQuota(db, apiKey) {
  const timestamp = nowIso();
  let access = await db.prepare("SELECT * FROM api_access WHERE api_key = ?")
    .bind(String(apiKey ?? "").trim())
    .first();

  if (!access) {
    throw new ApiError(401, "invalid_api_key");
  }

  if (access.revoked_at && !isUnlimitedApiAccess(access)) {
    throw new ApiError(403, "api_access_revoked");
  }

  if (!isUnlimitedApiAccess(access) && new Date(access.expires_at).getTime() <= Date.now()) {
    throw new ApiError(403, "api_access_expired");
  }

  if (isUnlimitedApiAccess(access)) {
    await db.prepare(`
      UPDATE api_access
      SET revoked_at = NULL, expires_at = ?, quota_daily = 0, quota_used = 0, last_used_at = ?
      WHERE user_id = ?
    `).bind(ADMIN_API_EXPIRES_AT, timestamp, access.user_id).run();

    return {
      access: {
        ...access,
        quota_daily: 0,
        quota_used: 0,
        expires_at: ADMIN_API_EXPIRES_AT,
        revoked_at: null,
        last_used_at: timestamp,
      },
      remaining: null,
      unlimited: true,
    };
  }

  const today = getWibDateKey();
  if (access.quota_date !== today) {
    await db.prepare(`
      UPDATE api_access
      SET quota_date = ?, quota_used = 0
      WHERE user_id = ?
    `).bind(today, access.user_id).run();
    access = {
      ...access,
      quota_date: today,
      quota_used: 0,
    };
  }

  const quotaDaily = Number(access.quota_daily);
  const quotaUsed = Number(access.quota_used);
  if (quotaUsed >= quotaDaily) {
    throw new ApiError(429, "daily_quota_exceeded");
  }

  const result = await db.prepare(`
    UPDATE api_access
    SET quota_used = quota_used + 1, last_used_at = ?
    WHERE user_id = ?
      AND quota_date = ?
      AND quota_used < quota_daily
      AND revoked_at IS NULL
      AND expires_at > ?
  `).bind(timestamp, access.user_id, today, timestamp).run();

  if (result.meta?.changes === 0) {
    throw new ApiError(429, "daily_quota_exceeded");
  }

  const updated = {
    ...access,
    quota_used: quotaUsed + 1,
    quota_date: today,
    last_used_at: timestamp,
  };

  return {
    access: updated,
    remaining: Math.max(0, quotaDaily - updated.quota_used),
  };
}
