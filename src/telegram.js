import {
  API_ACCESS_DAYS,
  API_DAILY_QUOTA,
  MESSAGE_LIST_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  getAdminContact,
  getAdminIds,
} from "./constants.js";
import {
  buildEmailAddress,
  escapeHtml,
  formatTimestamp,
  getAllowedMailDomains,
  getNextWibResetLabel,
  isInboxActive,
  normalizeAlias,
  parseEmailAddress,
  requireMailDomain,
  splitSubaddress,
  splitTelegramText,
  trimTrailingBlankLines,
} from "./utils.js";
import { buildApiDoc } from "./api-doc.js";
import {
  createInboxForChat,
  deleteInboxCascade,
  getApiAccessByUserId,
  getChat,
  getInboxByAlias,
  getInboxForChat,
  getMessageByShortId,
  getMessageForChat,
  grantApiAccess,
  isApiAccessActive,
  isUnlimitedApiAccess,
  listApiAccess,
  listInboxesForChat,
  listMessagesByAlias,
  listMessagesForInbox,
  renewInboxForChat,
  revokeApiAccess,
  upsertChat,
} from "./db.js";

function languageOf(_chat) {
  return "id";
}

function isAdminId(env, value) {
  return getAdminIds(env).includes(String(value));
}

function resolvePublicBaseUrl(env) {
  const configured = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!configured) {
    return `https://${requireMailDomain(env)}`;
  }
  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }
  return `https://${configured}`;
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return { command: "", args: trimmed };
  }

  const firstSpace = trimmed.search(/\s/);
  const rawCommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  return {
    command: rawCommand.split("@")[0].toLowerCase(),
    args: firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim(),
  };
}

function commandGuide(lang, isAdmin, domain = "example.com") {
  const base = lang === "en"
    ? [
      `<b>Welcome to Temp Mail ${escapeHtml(domain)}</b>`,
      "",
      "Commands:",
      "/new - create a random inbox",
      "/new name - create a custom alias",
      "/my - list active inboxes",
      "/inbox name - show latest emails",
      "/read email@domain - read latest email",
      "/delete name - delete an inbox",
      "/api - get api-doc.md",
      "/help - show this help",
    ]
    : [
      "<b>Selamat datang di Temp Mail</b>",
      "",
      "Perintah:",
      "/new - buat inbox random",
      "/new nama - buat alias custom",
      "/my - daftar inbox aktif",
      "/inbox nama - lihat email terbaru",
      "/read email@domain - baca email terbaru",
      "/delete nama - hapus inbox",
      "/api - lihat akses REST API",
      "/help - bantuan",
    ];

  if (isAdmin) {
    base.push(
      "",
      "Admin:",
      "/read email@domain - cek email inbox siapapun",
      "/admin - admin help",
      "/grant &lt;user_id&gt; [days] [quota] - grant API access",
      "/revoke &lt;user_id&gt; - revoke API access",
      "/apiusers - list API users",
    );
  }

  return base.join("\n");
}

function invalidAliasText(lang, domain) {
  return lang === "en"
    ? `Alias is invalid. Use 3-32 lowercase letters, numbers, dot, underscore, or dash on ${domain}.`
    : `Alias tidak valid. Pakai 3-32 huruf kecil, angka, titik, underscore, atau dash di ${domain}.`;
}

function noInboxText(lang) {
  return lang === "en"
    ? "No active inbox yet. Use /new to create one."
    : "Belum ada inbox aktif. Pakai /new untuk membuat inbox.";
}

function maskApiKey(key) {
  const value = String(key || "");
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 9)}...${value.slice(-6)}`;
}

function profileFromMessage(message) {
  const from = message.from ?? {};
  return {
    chatId: String(message.chat.id),
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  };
}

function profileFromCallback(callbackQuery) {
  const from = callbackQuery.from ?? {};
  const chatId = callbackQuery.message?.chat?.id ?? from.id;
  return {
    chatId: String(chatId),
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  };
}

export async function callTelegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("telegram_token_missing");
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`telegram_${method}_failed_${response.status}`);
  }

  return data.result;
}

export async function sendTelegramDocument(env, chatId, {
  filename,
  content,
  caption = null,
  contentType = "text/markdown; charset=utf-8",
}) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("telegram_token_missing");
  }

  const boundary = `----codex-${crypto.randomUUID()}`;
  const bodyParts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="chat_id"',
    "",
    String(chatId),
  ];

  if (caption) {
    bodyParts.push(
      `--${boundary}`,
      'Content-Disposition: form-data; name="caption"',
      "",
      caption,
    );
  }

  bodyParts.push(
    `--${boundary}`,
    `Content-Disposition: form-data; name="document"; filename="${filename.replaceAll("\"", "")}"`,
    `Content-Type: ${contentType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  );

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyParts.join("\r\n"),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`telegram_sendDocument_failed_${response.status}`);
  }

  return data.result;
}

export async function sendTelegramText(env, chatId, text, extra = {}) {
  const chunks = splitTelegramText(text, TELEGRAM_MESSAGE_LIMIT);
  const parseMode = Object.hasOwn(extra, "parse_mode") ? extra.parse_mode : "HTML";

  for (let index = 0; index < chunks.length; index += 1) {
    const payload = {
      chat_id: String(chatId),
      text: chunks[index],
      disable_web_page_preview: true,
      ...extra,
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    } else {
      delete payload.parse_mode;
    }

    if (index > 0) {
      delete payload.reply_markup;
    }

    await callTelegramApi(env, "sendMessage", payload);
  }
}

export async function safeSendTelegramText(env, chatId, text, extra = {}) {
  try {
    await sendTelegramText(env, chatId, text, extra);
    return true;
  } catch (error) {
    console.error("Telegram send failed", error);
    return false;
  }
}

async function safeAnswerCallbackQuery(env, callbackQueryId, text = "") {
  try {
    await callTelegramApi(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (error) {
    console.error("Telegram callback answer failed", error);
  }
}

async function sendStart(env, chatId, lang, admin) {
  await sendTelegramText(env, chatId, commandGuide(lang, admin, requireMailDomain(env)));
}

function formatInboxLine(inbox, fallbackDomain) {
  const domain = inbox.domain || fallbackDomain;
  return `<code>${escapeHtml(buildEmailAddress(inbox.alias, domain))}</code> - permanen`;
}

async function handleNewInbox(env, chatId, args, lang) {
  const domain = requireMailDomain(env);
  let alias = null;

  if (args) {
    try {
      alias = normalizeAlias(args.split(/\s+/)[0], domain);
    } catch {
      await sendTelegramText(env, chatId, invalidAliasText(lang, domain));
      return;
    }
  }

  try {
    const inbox = await createInboxForChat(env.DB, {
      chatId,
      domain,
      alias,
      permanent: true,
    });
    const address = buildEmailAddress(inbox.alias, domain);
    const text = lang === "en"
      ? [
        "<b>Inbox created</b>",
        `Address: <code>${escapeHtml(address)}</code>`,
        "Status: permanent",
        "",
        `Subaddressing works too: <code>${escapeHtml(`${inbox.alias}+tag@${domain}`)}</code>`,
      ].join("\n")
      : [
        "<b>Inbox dibuat</b>",
        `Alamat: <code>${escapeHtml(address)}</code>`,
        "Status: permanen",
        "",
        `Subaddressing juga bisa: <code>${escapeHtml(`${inbox.alias}+tag@${domain}`)}</code>`,
      ].join("\n");

    await sendTelegramText(env, chatId, text);
  } catch (error) {
    const text = error.message === "alias_taken"
      ? (lang === "en" ? "That alias is already active." : "Alias itu sedang aktif.")
      : (lang === "en" ? "Failed to create inbox." : "Gagal membuat inbox.");
    await sendTelegramText(env, chatId, text);
  }
}

async function handleMyInboxes(env, chatId, lang) {
  const domain = requireMailDomain(env);
  const inboxes = await listInboxesForChat(env.DB, chatId);
  if (inboxes.length === 0) {
    await sendTelegramText(env, chatId, noInboxText(lang));
    return;
  }

  const lines = [
    lang === "en" ? "<b>Active inboxes</b>" : "<b>Inbox aktif</b>",
    "",
    ...inboxes.map((inbox) => formatInboxLine(inbox, domain)),
  ];

  await sendTelegramText(env, chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: inboxes.map((inbox) => [
        { text: buildEmailAddress(inbox.alias, domain), callback_data: `box:${inbox.alias}` },
      ]),
    },
  });
}

async function displayInboxMessages(env, chatId, alias, lang) {
  const domain = requireMailDomain(env);
  const inbox = await getInboxForChat(env.DB, chatId, alias);
  if (!inbox || !isInboxActive(inbox)) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "Inbox not found." : "Inbox tidak ditemukan.",
    );
    return;
  }

  const messages = await listMessagesForInbox(env.DB, chatId, alias, MESSAGE_LIST_LIMIT);
  if (messages.length === 0) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "No email in this inbox yet." : "Belum ada email di inbox ini.",
    );
    return;
  }

  const lines = [
    lang === "en"
      ? `<b>Latest email for ${escapeHtml(buildEmailAddress(alias, domain))}</b>`
      : `<b>Email terbaru untuk ${escapeHtml(buildEmailAddress(alias, domain))}</b>`,
    "",
    ...messages.map((message) => {
      const subject = message.subject || "(no subject)";
      return `<code>${escapeHtml(message.short_id)}</code> - ${escapeHtml(subject)} from ${escapeHtml(message.from_address)} (${escapeHtml(formatTimestamp(message.received_at))})`;
    }),
    "",
    lang === "en"
      ? `Use <code>/read ${escapeHtml(buildEmailAddress(alias, domain))}</code> to read the latest email.`
      : `Pakai <code>/read ${escapeHtml(buildEmailAddress(alias, domain))}</code> untuk membaca email terbaru.`,
  ];

  await sendTelegramText(env, chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: messages.map((message) => [
        { text: `${message.short_id} - ${message.subject || "(no subject)"}`.slice(0, 60), callback_data: `open:${message.short_id}` },
      ]),
    },
  });
}

export async function sendFullEmail(env, chatId, message, lang = "id") {
  const header = trimTrailingBlankLines([
    lang === "en" ? "<b>Email detail</b>" : "<b>Detail email</b>",
    "",
    `ID: <code>${escapeHtml(message.short_id)}</code>`,
    `Inbox: <code>${escapeHtml(message.alias)}</code>`,
    `From: ${escapeHtml(message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address)}`,
    `To: ${escapeHtml(message.to_address)}`,
    message.delivered_to ? `Delivered-To: ${escapeHtml(message.delivered_to)}` : "",
    message.recipient_tag ? `Tag: <code>${escapeHtml(message.recipient_tag)}</code>` : "",
    `Subject: ${escapeHtml(message.subject || "(no subject)")}`,
    `Received: ${escapeHtml(formatTimestamp(message.received_at))}`,
  ]).join("\n");

  await sendTelegramText(env, chatId, header);

  const body = message.text_body || message.snippet || (lang === "en" ? "(no text body)" : "(tidak ada isi teks)");
  await sendTelegramText(env, chatId, body, { parse_mode: null });
}

async function handleReadEmail(env, chatId, args, lang, admin = false) {
  const domain = requireMailDomain(env);
  const input = args.split(/\s+/)[0];
  if (!input) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "Usage: /read email@domain" : `Format: /read email@${domain}`,
    );
    return;
  }

  // Admin path: can read any inbox regardless of ownership
  if (admin) {
    let alias;
    const parsed = parseEmailAddress(input);
    if (parsed) {
      const domains = getAllowedMailDomains(env);
      if (!domains.includes(parsed.domain)) {
        await sendTelegramText(env, chatId,
          `Domain <code>${escapeHtml(parsed.domain)}</code> tidak dikenali.`);
        return;
      }
      alias = splitSubaddress(parsed.localPart).alias;
    } else {
      try {
        alias = normalizeAlias(input, domain);
      } catch {
        await sendTelegramText(env, chatId, `Format: /read email@domain`);
        return;
      }
    }

    const inbox = await getInboxByAlias(env.DB, alias);
    const inboxDomain = inbox?.domain || domain;
    const address = buildEmailAddress(alias, inboxDomain);
    const messages = await listMessagesByAlias(env.DB, alias, MESSAGE_LIST_LIMIT);

    // No inbox AND no messages — truly not found
    if (!inbox && messages.length === 0) {
      await sendTelegramText(env, chatId,
        `\u{1F4ED} Inbox <code>${escapeHtml(address)}</code> tidak ditemukan di database.`);
      return;
    }

    const statusEmoji = inbox ? (isInboxActive(inbox) ? "\u2705" : "\u274C") : "\u{1F5D1}\uFE0F";
    const statusText = inbox ? (isInboxActive(inbox) ? "Aktif" : "Nonaktif") : "Deleted";
    const ownerText = inbox?.chat_id || (messages[0]?.chat_id || "unknown");

    if (messages.length === 0) {
      await sendTelegramText(env, chatId, [
        `<b>\u{1F4EC} Admin Read</b>`,
        `Alamat: <code>${escapeHtml(address)}</code>`,
        `Owner: <code>${escapeHtml(ownerText)}</code>`,
        `Status: ${statusEmoji} ${statusText}`,
        "",
        "\u{1F4ED} Belum ada email masuk.",
      ].filter(Boolean).join("\n"));
      return;
    }

    const headerLines = [
      `<b>\u{1F4EC} Admin Read</b>`,
      `Alamat: <code>${escapeHtml(address)}</code>`,
      `Owner: <code>${escapeHtml(ownerText)}</code>`,
      `Status: ${statusEmoji} ${statusText}`,
    ];
    headerLines.push(
      `Email: ${messages.length} pesan`,
      "",
      ...messages.map((msg) => {
        const subject = msg.subject || "(no subject)";
        return `<code>${escapeHtml(msg.short_id)}</code> - ${escapeHtml(subject)} dari ${escapeHtml(msg.from_address)} (${escapeHtml(formatTimestamp(msg.received_at))})`;
      }),
    );

    await sendTelegramText(env, chatId, headerLines.join("\n"), {
      reply_markup: {
        inline_keyboard: messages.slice(0, 5).map((msg) => [
          {
            text: `${msg.short_id} - ${(msg.subject || "(no subject)").slice(0, 50)}`,
            callback_data: `aread:${msg.short_id}`,
          },
        ]),
      },
    });

    // Auto-display the latest email content for admin
    const latestFull = await getMessageByShortId(env.DB, messages[0].short_id);
    if (latestFull) {
      await sendFullEmail(env, chatId, latestFull, lang);
    }
    return;
  }

  // Regular user flow
  let alias;
  try {
    alias = normalizeAlias(input, domain);
  } catch {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "Usage: /read email@domain" : `Format: /read email@${domain}`,
    );
    return;
  }

  const inbox = await getInboxForChat(env.DB, chatId, alias);
  if (!inbox || !isInboxActive(inbox)) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "Inbox not found." : "Inbox tidak ditemukan.",
    );
    return;
  }

  const [latestMessage] = await listMessagesForInbox(env.DB, chatId, alias, 1);
  if (!latestMessage) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en" ? "No email in this inbox yet." : "Belum ada email di inbox ini.",
    );
    return;
  }

  await sendFullEmail(env, chatId, latestMessage, lang);
}

async function handleRenewInbox(env, chatId, args, lang) {
  const domain = requireMailDomain(env);
  let alias;
  try {
    alias = normalizeAlias(args.split(/\s+/)[0], domain);
  } catch {
    await sendTelegramText(env, chatId, lang === "en" ? "Usage: /renew alias" : "Format: /renew alias");
    return;
  }

  const inbox = await renewInboxForChat(env.DB, chatId, alias, null);
  if (!inbox) {
    await sendTelegramText(env, chatId, lang === "en" ? "Inbox not found." : "Inbox tidak ditemukan.");
    return;
  }

  await sendTelegramText(
    env,
    chatId,
    lang === "en"
      ? `Inbox <code>${escapeHtml(buildEmailAddress(alias, domain))}</code> is permanent. /renew is not needed.`
      : `Inbox <code>${escapeHtml(buildEmailAddress(alias, domain))}</code> sudah permanen. /renew tidak diperlukan.`,
  );
}

async function handleDeleteInbox(env, chatId, args, lang) {
  const domain = requireMailDomain(env);
  let alias;
  try {
    alias = normalizeAlias(args.split(/\s+/)[0], domain);
  } catch {
    await sendTelegramText(env, chatId, lang === "en" ? "Usage: /delete alias" : "Format: /delete alias");
    return;
  }

  const deleted = await deleteInboxCascade(env.DB, { alias, chatId });
  await sendTelegramText(
    env,
    chatId,
    deleted
      ? (lang === "en" ? "Inbox deleted." : "Inbox dihapus.")
      : (lang === "en" ? "Inbox not found." : "Inbox tidak ditemukan."),
  );
}

async function handleApiInfo(env, chatId, userId, lang) {
  const access = await getApiAccessByUserId(env.DB, env, userId);
  const baseUrl = resolvePublicBaseUrl(env);
  const adminContact = getAdminContact(env);
  if (!isApiAccessActive(access)) {
    await sendTelegramText(
      env,
      chatId,
      lang === "en"
        ? `You do not have API access yet. Please chat admin ${adminContact}.`
        : `Kamu belum punya akses API. Silakan chat admin ${adminContact}.`,
    );
    return;
  }

  if (isUnlimitedApiAccess(access)) {
    await sendTelegramText(
      env,
      chatId,
      [
        "<b>Akses REST API</b>",
        `Base URL: <code>${escapeHtml(baseUrl)}</code>`,
        `Header: <code>X-API-Key: ${escapeHtml(access.api_key)}</code>`,
        "Kuota: unlimited",
        "Berlaku sampai: unlimited",
      ].join("\n"),
    );
  } else {
    const used = Number(access.quota_used);
    const limit = Number(access.quota_daily);
    const remaining = Math.max(0, limit - used);
    await sendTelegramText(
      env,
      chatId,
      [
        "<b>Akses REST API</b>",
        `Base URL: <code>${escapeHtml(baseUrl)}</code>`,
        `Header: <code>X-API-Key: ${escapeHtml(access.api_key)}</code>`,
        `Kuota: ${used}/${limit} terpakai, sisa ${remaining}`,
        `Reset: ${escapeHtml(getNextWibResetLabel())}`,
        `Berlaku sampai: ${escapeHtml(formatTimestamp(access.expires_at))}`,
      ].join("\n"),
    );
  }

  const domains = getAllowedMailDomains(env);
  const content = buildApiDoc(access, domains, baseUrl);

  try {
    await sendTelegramDocument(env, chatId, {
      filename: "api-doc.md",
      content,
    });
  } catch (error) {
    console.error("Telegram document send failed", error);
    await sendTelegramText(
      env,
      chatId,
      lang === "en"
        ? "Failed to send api-doc.md. Please try again in a moment."
        : "Gagal mengirim api-doc.md. Coba lagi sebentar.",
    );
  }
}

async function handleAdminHelp(env, chatId, lang, userId) {
  if (!isAdminId(env, userId)) {
    await sendTelegramText(env, chatId, lang === "en" ? "Admin only." : "Khusus admin.");
    return;
  }

  const lines = [
    "<b>Admin Commands</b>",
    "",
    "<b>Email:</b>",
    "/read email@domain - cek inbox siapapun (lihat email masuk)",
    "",
    "<b>API:</b>",
    "Admin punya akses API default unlimited.",
    `/grant &lt;user_id&gt; [days] [quota] - default ${API_ACCESS_DAYS} days, ${API_DAILY_QUOTA}/day`,
    "/revoke &lt;user_id&gt; - revoke API access",
    "/apiusers - list API users",
  ];
  await sendTelegramText(env, chatId, lines.join("\n"));
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function handleGrant(env, chatId, args, lang, adminUserId) {
  if (!isAdminId(env, adminUserId)) {
    await sendTelegramText(env, chatId, lang === "en" ? "Admin only." : "Khusus admin.");
    return;
  }

  const [targetUserId, daysArg, quotaArg] = args.split(/\s+/).filter(Boolean);
  if (!targetUserId || !/^\d{3,20}$/.test(targetUserId)) {
    await sendTelegramText(env, chatId, "Format: /grant &lt;user_id&gt; [days] [quota]");
    return;
  }

  const days = parsePositiveInt(daysArg, API_ACCESS_DAYS);
  const quotaDaily = parsePositiveInt(quotaArg, API_DAILY_QUOTA);
  const access = await grantApiAccess(env.DB, env, {
    userId: targetUserId,
    grantedBy: adminUserId,
    days,
    quotaDaily,
  });

  const lines = isUnlimitedApiAccess(access)
    ? [
      "<b>Akses API dibuat</b>",
      `User ID: <code>${escapeHtml(targetUserId)}</code>`,
      "Kuota: unlimited",
      "Durasi: unlimited",
      `API key: <code>${escapeHtml(access.api_key)}</code>`,
    ]
    : [
      "<b>Akses API dibuat</b>",
      `User ID: <code>${escapeHtml(targetUserId)}</code>`,
      `Kuota: ${quotaDaily}/hari`,
      `Durasi: ${days} hari`,
      `Berlaku sampai: ${escapeHtml(formatTimestamp(access.expires_at))}`,
      `API key: <code>${escapeHtml(access.api_key)}</code>`,
    ];
  await sendTelegramText(env, chatId, lines.join("\n"));

  const targetChat = await getChat(env.DB, targetUserId);
  const targetLang = languageOf(targetChat);
  await safeSendTelegramText(
    env,
    targetUserId,
    targetLang === "en"
      ? "Your REST API access is active. Use /api to view your key and quota."
      : "Akses REST API kamu sudah aktif. Pakai /api untuk melihat key dan kuota.",
  );
}

async function handleRevoke(env, chatId, args, lang, adminUserId) {
  if (!isAdminId(env, adminUserId)) {
    await sendTelegramText(env, chatId, lang === "en" ? "Admin only." : "Khusus admin.");
    return;
  }

  const targetUserId = args.split(/\s+/)[0];
  if (!targetUserId || !/^\d{3,20}$/.test(targetUserId)) {
    await sendTelegramText(env, chatId, "Format: /revoke &lt;user_id&gt;");
    return;
  }

  const changes = await revokeApiAccess(env.DB, env, targetUserId);
  await sendTelegramText(
    env,
    chatId,
    changes > 0 ? "Akses API dicabut." : "Akses API tidak ditemukan atau sudah dicabut.",
  );
}

function accessStatus(access) {
  if (access.revoked_at) {
    return "revoked";
  }
  if (!isApiAccessActive(access)) {
    return "expired";
  }
  return "active";
}

async function handleApiUsers(env, chatId, lang, adminUserId) {
  if (!isAdminId(env, adminUserId)) {
    await sendTelegramText(env, chatId, lang === "en" ? "Admin only." : "Khusus admin.");
    return;
  }

  const accesses = await listApiAccess(env.DB, env, 20);
  if (accesses.length === 0) {
    await sendTelegramText(env, chatId, "Belum ada user API.");
    return;
  }

  const lines = [
    "<b>User API</b>",
    "",
    ...accesses.map((access) => {
      const quotaLabel = isUnlimitedApiAccess(access)
        ? "unlimited"
        : `${Number(access.quota_used)}/${Number(access.quota_daily)}`;
      const expiresLabel = isUnlimitedApiAccess(access)
        ? "unlimited"
        : `exp ${formatTimestamp(access.expires_at)}`;
      return [
        `<code>${escapeHtml(access.user_id)}</code>`,
        accessStatus(access),
        quotaLabel,
        maskApiKey(access.api_key),
        expiresLabel,
      ].join(" - ");
    }),
  ];
  await sendTelegramText(env, chatId, lines.join("\n"));
}

async function handleMessage(message, env) {
  const profile = profileFromMessage(message);
  const fromId = String(message.from?.id ?? profile.chatId);
  await upsertChat(env.DB, profile);

  const chat = await getChat(env.DB, profile.chatId);
  const text = String(message.text || "").trim();
  const { command, args } = parseCommand(text);

  const lang = languageOf(chat);
  const admin = isAdminId(env, fromId);

  switch (command) {
    case "/start":
    case "/help":
      await sendStart(env, profile.chatId, lang, admin);
      break;
    case "/new":
      await handleNewInbox(env, profile.chatId, args, lang);
      break;
    case "/my":
      await handleMyInboxes(env, profile.chatId, lang);
      break;
    case "/inbox": {
      const domain = requireMailDomain(env);
      let alias;
      try {
        alias = normalizeAlias(args.split(/\s+/)[0], domain);
      } catch {
        await sendTelegramText(env, profile.chatId, lang === "en" ? "Usage: /inbox alias" : "Format: /inbox alias");
        return;
      }
      await displayInboxMessages(env, profile.chatId, alias, lang);
      break;
    }
    case "/read":
      await handleReadEmail(env, profile.chatId, args, lang, admin);
      break;
    case "/renew":
      await handleRenewInbox(env, profile.chatId, args, lang);
      break;
    case "/delete":
      await handleDeleteInbox(env, profile.chatId, args, lang);
      break;
    case "/api":
      await handleApiInfo(env, profile.chatId, fromId, lang);
      break;
    case "/admin":
      await handleAdminHelp(env, profile.chatId, lang, fromId);
      break;
    case "/grant":
      await handleGrant(env, profile.chatId, args, lang, fromId);
      break;
    case "/revoke":
      await handleRevoke(env, profile.chatId, args, lang, fromId);
      break;
    case "/apiusers":
      await handleApiUsers(env, profile.chatId, lang, fromId);
      break;
    default:
      await sendTelegramText(env, profile.chatId, commandGuide(lang, admin, requireMailDomain(env)));
      break;
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const profile = profileFromCallback(callbackQuery);
  const fromId = String(callbackQuery.from?.id ?? profile.chatId);
  await upsertChat(env.DB, profile);
  const chat = await getChat(env.DB, profile.chatId);
  const data = String(callbackQuery.data || "");

  const lang = languageOf(chat);
  if (data.startsWith("box:")) {
    await safeAnswerCallbackQuery(env, callbackQuery.id);
    await displayInboxMessages(env, profile.chatId, data.slice(4), lang);
    return;
  }

  if (data.startsWith("open:")) {
    await safeAnswerCallbackQuery(env, callbackQuery.id);
    const message = await getMessageForChat(env.DB, profile.chatId, data.slice(5));
    if (!message) {
      await sendTelegramText(env, profile.chatId, lang === "en" ? "Email not found." : "Email tidak ditemukan.");
      return;
    }
    await sendFullEmail(env, profile.chatId, message, lang);
    return;
  }

  if (data.startsWith("aread:")) {
    await safeAnswerCallbackQuery(env, callbackQuery.id);
    if (!isAdminId(env, fromId)) {
      await sendTelegramText(env, profile.chatId, "Khusus admin.");
      return;
    }
    const message = await getMessageByShortId(env.DB, data.slice(6));
    if (!message) {
      await sendTelegramText(env, profile.chatId, "Email tidak ditemukan.");
      return;
    }
    await sendFullEmail(env, profile.chatId, message, lang);
    return;
  }

  await safeAnswerCallbackQuery(env, callbackQuery.id);
}

export async function handleTelegramUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
  }
}

export async function notifyTelegramNewMail(env, message, inbox) {
  const chat = await getChat(env.DB, inbox.chat_id);
  const lang = languageOf(chat);
  const domain = inbox.domain || requireMailDomain(env);
  const subject = message.subject || "(no subject)";
  const from = message.from_name
    ? `${message.from_name} <${message.from_address}>`
    : message.from_address;

  const lines = lang === "en"
    ? [
      "<b>New email received</b>",
      `Inbox: <code>${escapeHtml(buildEmailAddress(inbox.alias, domain))}</code>`,
      `From: ${escapeHtml(from)}`,
      `Subject: ${escapeHtml(subject)}`,
      `ID: <code>${escapeHtml(message.short_id)}</code>`,
      "",
      `Use <code>/read ${escapeHtml(buildEmailAddress(inbox.alias, domain))}</code> to open latest email.`,
    ]
    : [
      "<b>Email baru masuk</b>",
      `Inbox: <code>${escapeHtml(buildEmailAddress(inbox.alias, domain))}</code>`,
      `Dari: ${escapeHtml(from)}`,
      `Subjek: ${escapeHtml(subject)}`,
      `ID: <code>${escapeHtml(message.short_id)}</code>`,
      "",
      `Pakai <code>/read ${escapeHtml(buildEmailAddress(inbox.alias, domain))}</code> untuk membuka email terbaru.`,
    ];

  return safeSendTelegramText(env, inbox.chat_id, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: lang === "en" ? "Read email" : "Baca email", callback_data: `open:${message.short_id}` }],
      ],
    },
  });
}
