import { MESSAGE_LIST_LIMIT } from "./constants.js";
import {
  ApiError,
  buildEmailAddress,
  getNextWibResetLabel,
  getAllowedMailDomains,
  isInboxActive,
  json,
  normalizeApiAlias,
  parseEmailAddress,
  parseApiRoute,
  readJsonBody,
  requireMailDomain,
} from "./utils.js";
import {
  consumeApiQuota,
  createInboxForChat,
  deleteInboxCascade,
  deleteApiWebhook,
  getApiWebhookByUserId,
  getApiChatId,
  getInboxForChat,
  getMessageForChat,
  listInboxesForChat,
  listMessagesForInbox,
  upsertApiWebhook,
} from "./db.js";
import { dispatchApiWebhook } from "./webhook.js";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "Authorization,Content-Type,X-API-Key",
};

function apiJson(value, init = {}) {
  return json(value, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

function extractApiKey(request) {
  const directKey = request.headers.get("x-api-key");
  if (directKey) {
    return directKey.trim();
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireApiUsage(request, env) {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    throw new ApiError(401, "missing_api_key");
  }

  return consumeApiQuota(env.DB, apiKey);
}

function quotaPayload(usage) {
  if (usage.unlimited) {
    return {
      used: null,
      limit: null,
      remaining: null,
      resetAt: null,
      expiresAt: null,
      unlimited: true,
    };
  }

  return {
    used: Number(usage.access.quota_used),
    limit: Number(usage.access.quota_daily),
    remaining: usage.remaining,
    resetAt: getNextWibResetLabel(),
    expiresAt: usage.access.expires_at,
    unlimited: false,
  };
}

function inboxPayload(inbox) {
  return {
    alias: inbox.alias,
    address: buildEmailAddress(inbox.alias, inbox.domain),
    domain: inbox.domain,
    createdAt: inbox.created_at,
    expiresAt: inbox.expires_at,
    isActive: Boolean(Number(inbox.is_active)),
    lastMessageAt: inbox.last_message_at,
  };
}

function messageListPayload(message) {
  return {
    id: message.short_id,
    inbox: message.alias,
    from: {
      address: message.from_address,
      name: message.from_name,
    },
    to: message.to_address,
    deliveredTo: message.delivered_to,
    tag: message.recipient_tag,
    subject: message.subject,
    snippet: message.snippet,
    rawSize: message.raw_size,
    receivedAt: message.received_at,
  };
}

function parseHeadersJson(value) {
  if (!value) {
    return [];
  }

  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function messagePayload(message) {
  return {
    ...messageListPayload(message),
    text: message.text_body,
    html: message.html_body,
    headers: parseHeadersJson(message.headers_json),
  };
}

function normalizeWebhookUrl(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new ApiError(400, "webhook_url_required");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "invalid_webhook_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "invalid_webhook_protocol");
  }

  return url.toString();
}

function webhookPayload(webhook) {
  if (!webhook) {
    return null;
  }

  return {
    url: webhook.webhook_url,
    hasSecret: Boolean(webhook.webhook_secret),
    updatedAt: webhook.updated_at,
    lastSuccessAt: webhook.last_success_at,
    lastFailureAt: webhook.last_failure_at,
    lastStatusCode: webhook.last_status_code,
    lastError: webhook.last_error,
  };
}

function normalizeRequestedDomain(rawValue, allowedDomains, defaultDomain) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return defaultDomain;
  }

  const value = String(rawValue).trim().toLowerCase();
  if (!allowedDomains.includes(value)) {
    throw new ApiError(400, "invalid_domain");
  }

  return value;
}

function normalizeAliasFromRoute(rawValue, allowedDomains, defaultDomain) {
  const value = String(rawValue ?? "").trim().toLowerCase();
  if (value.includes("@")) {
    const parsed = parseEmailAddress(value);
    if (!parsed || !allowedDomains.includes(parsed.domain)) {
      throw new ApiError(400, "invalid_domain");
    }
    return normalizeApiAlias(parsed.localPart, parsed.domain);
  }

  return normalizeApiAlias(value, defaultDomain);
}

async function routeProtectedApi(request, env, route) {
  const usage = await requireApiUsage(request, env);
  const allowedDomains = getAllowedMailDomains(env);
  const defaultDomain = allowedDomains[0] ?? requireMailDomain(env);
  const chatId = getApiChatId(usage.access.user_id);
  const quota = quotaPayload(usage);

  if (request.method === "GET" && route.length === 1 && route[0] === "webhook") {
    const webhook = await getApiWebhookByUserId(env.DB, usage.access.user_id);
    return apiJson({
      ok: true,
      webhook: webhookPayload(webhook),
      quota,
    });
  }

  if (request.method === "PUT" && route.length === 1 && route[0] === "webhook") {
    const body = await readJsonBody(request);
    const webhookUrl = normalizeWebhookUrl(body.url ?? body.webhook_url);
    const webhookSecret = body.secret ? String(body.secret).trim() : null;
    const saved = await upsertApiWebhook(env.DB, {
      userId: usage.access.user_id,
      webhookUrl,
      webhookSecret,
    });

    return apiJson({
      ok: true,
      webhook: webhookPayload(saved),
      quota,
    });
  }

  if (request.method === "DELETE" && route.length === 1 && route[0] === "webhook") {
    const deleted = await deleteApiWebhook(env.DB, usage.access.user_id);
    return apiJson({
      ok: true,
      deleted: deleted > 0,
      quota,
    });
  }

  if (request.method === "POST" && route.length === 2 && route[0] === "webhook" && route[1] === "test") {
    const webhook = await getApiWebhookByUserId(env.DB, usage.access.user_id);
    if (!webhook) {
      throw new ApiError(404, "webhook_not_configured");
    }

    const result = await dispatchApiWebhook(env, {
      userId: usage.access.user_id,
      event: "webhook.test",
      data: {
        message: "Webhook test from temp mail API",
        user_id: usage.access.user_id,
      },
    });

    return apiJson({
      ok: true,
      sent: result.sent,
      result,
      webhook: webhookPayload(await getApiWebhookByUserId(env.DB, usage.access.user_id)),
      quota,
    });
  }

  if (request.method === "POST" && route.length === 1 && route[0] === "inboxes") {
    const body = await readJsonBody(request);
    let domain = normalizeRequestedDomain(body.domain, allowedDomains, defaultDomain);
    let alias = null;

    if (body.alias) {
      const rawAlias = String(body.alias).trim().toLowerCase();
      if (rawAlias.includes("@")) {
        const parsed = parseEmailAddress(rawAlias);
        if (!parsed || !allowedDomains.includes(parsed.domain)) {
          throw new ApiError(400, "invalid_domain");
        }
        if (body.domain && parsed.domain !== domain) {
          throw new ApiError(400, "alias_domain_mismatch");
        }
        domain = parsed.domain;
        alias = normalizeApiAlias(parsed.localPart, domain);
      } else {
        alias = normalizeApiAlias(rawAlias, domain);
      }
    }

    const inbox = await createInboxForChat(env.DB, {
      chatId,
      domain,
      alias,
      permanent: true,
    });

    return apiJson({
      ok: true,
      inbox: inboxPayload(inbox),
      quota,
    }, { status: 201 });
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "inboxes") {
    const inboxes = await listInboxesForChat(env.DB, chatId, 100);
    return apiJson({
      ok: true,
      inboxes: inboxes.map((inbox) => inboxPayload(inbox)),
      quota,
    });
  }

  if (
    request.method === "GET"
    && route.length === 3
    && route[0] === "inboxes"
    && route[2] === "messages"
  ) {
    const alias = normalizeAliasFromRoute(route[1], allowedDomains, defaultDomain);
    const inbox = await getInboxForChat(env.DB, chatId, alias);
    if (!inbox || !isInboxActive(inbox)) {
      throw new ApiError(404, "inbox_not_found");
    }

    const messages = await listMessagesForInbox(env.DB, chatId, alias, MESSAGE_LIST_LIMIT);
    return apiJson({
      ok: true,
      inbox: inboxPayload(inbox),
      messages: messages.map(messageListPayload),
      quota,
    });
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "messages") {
    const message = await getMessageForChat(env.DB, chatId, route[1]);
    if (!message) {
      throw new ApiError(404, "message_not_found");
    }

    return apiJson({
      ok: true,
      message: messagePayload(message),
      quota,
    });
  }

  if (request.method === "DELETE" && route.length === 2 && route[0] === "inboxes") {
    const alias = normalizeAliasFromRoute(route[1], allowedDomains, defaultDomain);
    const deleted = await deleteInboxCascade(env.DB, { alias, chatId });

    return apiJson({
      ok: true,
      deleted,
      quota,
    });
  }

  throw new ApiError(404, "api_route_not_found");
}

export async function handleApiRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const route = parseApiRoute(url.pathname);
  const allowedDomains = getAllowedMailDomains(env);
  const serviceName = `${requireMailDomain(env)} temp mail API`;

  try {
    if (request.method === "GET" && route.length === 0) {
      return apiJson({
        ok: true,
        service: serviceName,
        auth: "X-API-Key or Authorization: Bearer <key>",
        access: "Ask admin in Telegram, then use /api to view your key. Admin has default unlimited access.",
        webhook: {
          get: "GET /api/webhook",
          set: "PUT /api/webhook",
          remove: "DELETE /api/webhook",
          test: "POST /api/webhook/test",
        },
        domains: allowedDomains,
        quota: {
          daily: 1500,
          reset: "00:00 WIB",
        },
      });
    }

    if (request.method === "GET" && route.length === 1 && route[0] === "health") {
      return apiJson({
        ok: true,
        service: serviceName,
        time: new Date().toISOString(),
      });
    }

    return await routeProtectedApi(request, env, route);
  } catch (error) {
    if (error instanceof ApiError) {
      return apiJson({ ok: false, error: error.message }, { status: error.status });
    }

    console.error("API error", error);
    return apiJson({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
