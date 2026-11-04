// Shared helpers for the CATBYTE PREHUB Pages Functions API.
// Auth model: a signed, stateless token (HMAC-SHA256 over a JSON payload),
// issued by /api/login after checking ADMIN_EMAIL / ADMIN_PASSWORD (Pages secrets),
// and required as a Bearer token on any write to /api/state.
// Token secret: ADMIN_SECRET (Pages secret, never shipped to the browser).

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return decodeURIComponent(escape(atob(str)));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function makeToken(email, secret) {
  const payload = b64url(JSON.stringify({ email, exp: Date.now() + 7 * 24 * 3600 * 1000 }));
  const sig = await hmac(secret, payload);
  return payload + "." + sig;
}

export async function verifyToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = await hmac(secret, payload);
  if (expected !== sig) return false;
  let data;
  try {
    data = JSON.parse(b64urlDecode(payload));
  } catch (e) {
    return false;
  }
  if (!data || !data.exp || data.exp < Date.now()) return false;
  return true;
}

export function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : "";
}
