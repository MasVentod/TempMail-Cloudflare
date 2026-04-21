import PostalMime from "postal-mime";
import { API_CHAT_PREFIX } from "./constants.js";
import {
  compactWhitespace,
  createShortId,
  getAllowedMailDomains,
  getMaxBodyChars,
  isInboxActive,
  parseEmailAddress,
  parseMailbox,
  splitSubaddress,
  stripHtml,
  truncate,
} from "./utils.js";
import {
  getInboxByAlias,
  insertMessage,
  markMessageTelegramNotified,
} from "./db.js";
import { notifyTelegramNewMail } from "./telegram.js";
import { notifyApiWebhookNewMail } from "./webhook.js";

function firstMailbox(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = firstMailbox(item);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  if (typeof value === "object" && Array.isArray(value.group)) {
    return firstMailbox(value.group);
  }

  return parseMailbox(value);
}

function headerJson(parsedEmail) {
  try {
    return JSON.stringify(parsedEmail.headers ?? []);
  } catch {
    return "[]";
  }
}

function reject(message, reason) {
  message.setReject(reason);
}

export async function handleEmail(message, env, ctx) {
  const allowedDomains = getAllowedMailDomains(env);
  const recipient = parseEmailAddress(message.to);

  if (!recipient || !allowedDomains.includes(recipient.domain)) {
    reject(message, "invalid_recipient");
    return;
  }

  const { alias, tag } = splitSubaddress(recipient.localPart);
  const inbox = await getInboxByAlias(env.DB, alias);
  if (!inbox || !isInboxActive(inbox) || inbox.domain !== recipient.domain) {
    reject(message, "unknown_or_expired_inbox");
    return;
  }

  let parsedEmail;
  try {
    parsedEmail = await PostalMime.parse(message.raw, {
      attachmentEncoding: "base64",
      maxNestingDepth: 100,
    });
  } catch (error) {
    console.error("Email parse failed", error);
    reject(message, "email_parse_failed");
    return;
  }

  const maxBodyChars = getMaxBodyChars(env);
  const from = firstMailbox(parsedEmail.from) ?? parseMailbox(message.from) ?? {
    address: String(message.from || "unknown"),
    name: null,
  };
  const to = firstMailbox(parsedEmail.to) ?? parseMailbox(message.to) ?? {
    address: message.to,
    name: null,
  };
  const bodyText = parsedEmail.text || stripHtml(parsedEmail.html || "");
  const snippet = truncate(compactWhitespace(bodyText), 240);
  const receivedAt = new Date().toISOString();

  const storedMessage = {
    id: crypto.randomUUID(),
    short_id: createShortId(),
    alias,
    chat_id: inbox.chat_id,
    from_address: String(from.address || message.from || "unknown").toLowerCase(),
    from_name: from.name || null,
    to_address: String(to.address || message.to).toLowerCase(),
    subject: parsedEmail.subject || "(no subject)",
    snippet,
    text_body: truncate(bodyText, maxBodyChars),
    html_body: parsedEmail.html ? truncate(parsedEmail.html, maxBodyChars) : null,
    raw_size: message.rawSize ?? null,
    sender_message_id: parsedEmail.messageId || null,
    headers_json: headerJson(parsedEmail),
    received_at: receivedAt,
    telegram_notified_at: null,
    delivered_to: recipient.address,
    recipient_tag: tag,
  };

  await insertMessage(env.DB, storedMessage);

  if (String(inbox.chat_id).startsWith(API_CHAT_PREFIX)) {
    ctx.waitUntil((async () => {
      try {
        await notifyApiWebhookNewMail(env, inbox, storedMessage);
      } catch (error) {
        console.error("API webhook notify failed", error);
      }
    })());
    return;
  }

  ctx.waitUntil((async () => {
    const sent = await notifyTelegramNewMail(env, storedMessage, inbox);
    if (sent) {
      await markMessageTelegramNotified(env.DB, storedMessage.id);
    }
  })());
}
