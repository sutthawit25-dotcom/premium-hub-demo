import { json } from "./_utils.js";

// Catch-all for every /api/* route: an uncaught exception inside a function
// otherwise makes Cloudflare return its own generic HTML "Error 1101" page,
// which tells the admin UI nothing. Return the real reason as JSON instead.
export async function onRequest(context) {
  try {
    return await context.next();
  } catch (e) {
    const message = String((e && e.message) || e || "unknown").slice(0, 300);
    return json({ error: "server_exception", message }, 500);
  }
}
