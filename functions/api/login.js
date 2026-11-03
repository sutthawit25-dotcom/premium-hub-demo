import { json, makeToken } from "./_utils.js";

// POST /api/login  { email, password } -> { token }
// Credentials are never shipped to the browser: they live only as the
// ADMIN_EMAIL / ADMIN_PASSWORD Pages secrets, checked here on the server.
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  const email = (body && body.email ? String(body.email) : "").trim();
  const password = body && body.password ? String(body.password) : "";
  if (!email || !password) return json({ error: "missing_fields" }, 400);
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.ADMIN_SECRET) {
    return json({ error: "server_not_configured" }, 500);
  }
  if (email !== env.ADMIN_EMAIL || password !== env.ADMIN_PASSWORD) {
    return json({ error: "invalid_credentials" }, 401);
  }
  const token = await makeToken(email, env.ADMIN_SECRET);
  return json({ token: token });
}

export async function onRequestGet() {
  return json({ error: "method_not_allowed" }, 405);
}
