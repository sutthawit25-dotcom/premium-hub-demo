import { json, verifyToken, bearerToken } from "./_utils.js";

const KV_KEY = "state";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB safety cap

// GET /api/state -> the full saved shop state (public: the storefront needs
// plans/reviews/etc. without logging in). Returns null when nothing has been saved yet.
export async function onRequestGet({ env }) {
  if (!env.STATE_KV) return json({ error: "server_not_configured" }, 500);
  const raw = await env.STATE_KV.get(KV_KEY);
  return new Response(raw || "null", {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// POST /api/state -> overwrite the saved state. Requires a valid admin token
// (Authorization: Bearer <token>, issued by /api/login) so only the logged-in
// admin can write; reading never requires one.
export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  const token = bearerToken(request);
  const ok = await verifyToken(token, env.ADMIN_SECRET);
  if (!ok) return json({ error: "unauthorized" }, 401);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  if (!parsed || typeof parsed !== "object") return json({ error: "invalid_json" }, 400);

  await env.STATE_KV.put(KV_KEY, JSON.stringify(parsed));
  return json({ ok: true });
}
