import { handleFetch } from "./router.js";
import { handleEmail } from "./email.js";
import { cleanupExpiredInboxes } from "./db.js";

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },

  async email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpiredInboxes(env));
  },
};
