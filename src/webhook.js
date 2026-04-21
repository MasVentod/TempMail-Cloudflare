import { API_CHAT_PREFIX } from "./constants.js";
import { buildEmailAddress } from "./utils.js";
import {
  getApiWebhookByUserId,
  markApiWebhookDelivery,
} from "./db.js";

function getApiUserIdFromChatId(chatId) {
  const value = String(chatId || "");
  if (!value.startsWith(API_CHAT_PREFIX)) {
    return null;
  }
  return value.slice(API_CHAT_PREFIX.length) || null;
}

function toHex(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function signPayload(secret, payload) {
  const keyData = new TextEncoder().encode(String(secret));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(payload),
  );
  return toHex(signature);
}

export async function dispatchApiWebhook(env, {
  userId,
  event,
  data,
}) {
  const webhook = await getApiWebhookByUserId(env.DB, userId);
  if (!webhook) {
    return { sent: false, reason: "not_configured" };
  }

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    event,
    sent_at: timestamp,
    data,
  });
  const headers = {
    "content-type": "application/json",
    "x-tempmail-event": event,
    "x-tempmail-timestamp": timestamp,
    "x-tempmail-user-id": String(userId),
  };

  try {
    if (webhook.webhook_secret) {
      const signature = await signPayload(webhook.webhook_secret, payload);
      headers["x-tempmail-signature"] = `sha256=${signature}`;
    }

    const response = await fetch(webhook.webhook_url, {
      method: "POST",
      headers,
      body: payload,
    });

    if (!response.ok) {
      await markApiWebhookDelivery(env.DB, userId, {
        success: false,
        statusCode: response.status,
        error: `webhook_http_${response.status}`,
      });
      return {
        sent: false,
        reason: "http_error",
        status: response.status,
      };
    }

    await markApiWebhookDelivery(env.DB, userId, {
      success: true,
      statusCode: response.status,
    });
    return { sent: true, status: response.status };
  } catch (error) {
    await markApiWebhookDelivery(env.DB, userId, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, reason: "network_error" };
  }
}

export async function notifyApiWebhookNewMail(env, inbox, message) {
  const userId = getApiUserIdFromChatId(inbox.chat_id);
  if (!userId) {
    return { sent: false, reason: "not_api_inbox" };
  }

  const domain = String(inbox.domain || "").toLowerCase();
  return dispatchApiWebhook(env, {
    userId,
    event: "email.received",
    data: {
      inbox: {
        alias: inbox.alias,
        address: buildEmailAddress(inbox.alias, domain),
      },
      message: {
        id: message.short_id,
        from_address: message.from_address,
        from_name: message.from_name,
        to_address: message.to_address,
        delivered_to: message.delivered_to,
        recipient_tag: message.recipient_tag,
        subject: message.subject,
        snippet: message.snippet,
        received_at: message.received_at,
      },
    },
  });
}
