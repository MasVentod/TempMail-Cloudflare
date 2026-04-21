# Telegram Temp Mail Bot Template

Telegram bot template for creating temp mail inboxes on your Cloudflare domain. Incoming email is received through Cloudflare Email Routing, processed by an Email Worker, stored in D1, and then read from Telegram or the REST API.

## Features

- Temp mail inbox per Telegram user
- Random or custom aliases from the bot
- Read the latest email directly in Telegram
- REST API with per-user API keys
- API webhook for new incoming email
- Multi-domain and subaddressing support (`promo+tag@mail.example.com`)
- All email stays inside Cloudflare Worker + D1, with no forwarding to a personal inbox

## Project Structure

- `src/index.js` Worker entry
- `src/router.js` HTTP routing
- `src/telegram.js` Telegram bot commands and webhook
- `src/email.js` incoming email handler
- `src/api.js` REST API
- `src/db.js` D1 queries/helpers
- `src/utils.js` shared helpers
- `migrations/` D1 schema
- `wrangler.jsonc` default `workers.dev` template config
- `wrangler.example.jsonc` custom domain config example
- `.dev.vars.example` local secret example

## What To Change Before Deploying

Update `wrangler.jsonc` and adjust these values:

- `name`
- `MAIL_DOMAIN`
- `MAIL_DOMAINS`
- `PUBLIC_BASE_URL`
- `ADMIN_IDS`
- `ADMIN_CONTACT`
- `d1_databases[0].database_id`

Required secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

## Environment Configuration

Non-secret variables in `wrangler.jsonc`:

```jsonc
"vars": {
  "MAIL_DOMAIN": "mail.example.com",
  "MAIL_DOMAINS": "mail.example.com,mail2.example.com",
  "PUBLIC_BASE_URL": "https://tempmail-bot-template.<your-subdomain>.workers.dev",
  "ADMIN_IDS": "123456789,987654321",
  "ADMIN_CONTACT": "@yourtelegramusername",
  "INBOX_TTL_HOURS": "24",
  "MAX_BODY_CHARS": "12000",
  "AUTO_DELETE_EXPIRED": "true"
}
```

Notes:

- `ADMIN_IDS` is comma-separated
- the first admin is treated as the primary admin
- admins receive unlimited API access
- `PUBLIC_BASE_URL` is used for links and for the API documentation file sent by the bot

## Quick Setup

1. Create a Telegram bot with `@BotFather`
2. Install dependencies with `npm install`
3. Create a D1 database with `npx wrangler d1 create tempmail`
4. Copy the returned `database_id` into `wrangler.jsonc`
5. Add secrets with `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`
6. Run migrations with `npm run db:migrate:local` and then `npm run db:migrate:remote`
7. Deploy the Worker with `npm run deploy`
8. Set the Telegram webhook to `https://<worker-host>/telegram/webhook`
9. Enable Cloudflare Email Routing and point the address/catch-all to this Worker using the `Send to a Worker` action

## Set Telegram Webhook

```powershell
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" `
  -H "Content-Type: application/json" `
  -d "{\"url\":\"https://<worker-host>/telegram/webhook\",\"secret_token\":\"<TELEGRAM_WEBHOOK_SECRET>\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

`<worker-host>` can be a `workers.dev` domain or your custom domain.

## Email Routing Setup

1. Enable Email Routing for your temp mail domain
2. Make sure the Cloudflare MX and verification DNS records are valid
3. Create a custom address or catch-all for your temp mail domain/subdomain
4. Choose the `Send to a Worker` action
5. Point it to this Worker project

Important:

- Do not choose `Send to an email`
- Do not forward to Gmail/Outlook if you want a pure temp-mail flow
- The allowed domains must match `MAIL_DOMAIN` or `MAIL_DOMAINS`

## Bot Commands

- `/start` or `/help`
- `/new`
- `/new promo`
- `/my`
- `/inbox promo`
- `/read email@domain`
- `/renew promo`
- `/delete promo`
- `/api`

Admin commands:

- `/admin`
- `/grant <user_id>`
- `/grant <user_id> 30 1500`
- `/revoke <user_id>`
- `/apiusers`

## REST API

The base URL follows `PUBLIC_BASE_URL`.

Headers:

```text
X-API-Key: <USER_API_KEY>
Content-Type: application/json
```

Main endpoints:

- `GET /api/health`
- `POST /api/inboxes`
- `GET /api/inboxes`
- `GET /api/inboxes/{alias}/messages`
- `GET /api/messages/{id}`
- `DELETE /api/inboxes/{alias}`
- `GET /api/webhook`
- `PUT /api/webhook`
- `POST /api/webhook/test`
- `DELETE /api/webhook`

Webhook headers when an event is sent:

- `x-tempmail-event`
- `x-tempmail-timestamp`
- `x-tempmail-user-id`
- `x-tempmail-signature: sha256=<hmac>` when a secret is configured

Users with granted access can use `/api` to view their key, quota, and receive the generated `api-doc.md` file based on the active configuration.

## Development

- `npm run dev`
- `npm run check`

## Notes

- `AUTO_DELETE_EXPIRED=true` will clean up expired inboxes when cleanup is fully enabled
- If you want to store attachments or raw email, add a binding such as R2
- If you need full SMTP/IMAP support, that requires a different architecture and is outside the scope of this template

## References

- Cloudflare Email Workers Runtime API: [developers.cloudflare.com/email-routing/email-workers/runtime-api](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/)
- Cloudflare Email Routing setup: [developers.cloudflare.com/email-routing/setup/email-routing-addresses](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/)
- Cloudflare Email Routing subdomain: [developers.cloudflare.com/email-routing/setup/subdomains](https://developers.cloudflare.com/email-routing/setup/subdomains/)
- Telegram Bot API `setWebhook`: [core.telegram.org/bots/api#setwebhook](https://core.telegram.org/bots/api#setwebhook)
