import { json, verifyToken, bearerToken } from "./_utils.js";

// Shop images (banner slides, app logos) stored in KV under "img:<id>".
// POST (admin): raw image bytes with an image/* content-type -> { ok, id, url }
// GET  ?id=    : public, long-cached image bytes
// DELETE ?id=  (admin)
const MAX_BYTES = 1500 * 1024;
const TYPES = ["image/webp", "image/jpeg", "image/png", "image/gif", "image/avif"];

async function authed(request, env) {
  return !!(env.ADMIN_SECRET && (await verifyToken(bearerToken(request), env.ADMIN_SECRET)));
}

export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV) return json({ error: "server_not_configured" }, 500);
  if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401);
  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (TYPES.indexOf(ct) < 0) return json({ ok: false, error: "unsupported_type" }, 400);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ ok: false, error: "empty" }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  try {
    await env.STATE_KV.put("img:" + id, buf, { metadata: { ct, size: buf.byteLength, at: Date.now() } });
  } catch (e) {
    return json({ ok: false, error: "kv_write_failed" }, 500);
  }
  return json({ ok: true, id, url: "/api/img?id=" + id });
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[a-f0-9]{8,40}$/.test(id) || !env.STATE_KV) return new Response("not found", { status: 404 });
  const r = await env.STATE_KV.getWithMetadata("img:" + id, { type: "arrayBuffer" });
  if (!r || !r.value) return new Response("not found", { status: 404 });
  return new Response(r.value, {
    headers: {
      "content-type": (r.metadata && r.metadata.ct) || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export async function onRequestDelete({ request, env }) {
  if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[a-f0-9]{8,40}$/.test(id)) return json({ error: "bad_id" }, 400);
  await env.STATE_KV.delete("img:" + id);
  return json({ ok: true });
}
