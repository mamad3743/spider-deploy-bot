/**
 * Cloudflare Worker entry point — لایه‌ی نازک روی bot-core.js
 * منطق واقعی همه توی bot-core.js هست تا با ورژن Railway (server.js) مشترک بمونه.
 */
import { handleFetch, handleScheduled } from "./bot-core.js";

export default {
  fetch: handleFetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
