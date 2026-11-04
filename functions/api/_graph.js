// Microsoft Graph access to a personal Hotmail/Outlook mailbox, used instead
// of IMAP (Microsoft no longer accepts passwords/app-passwords over IMAP for
// personal accounts). Each mailbox is connected once through the normal
// Microsoft sign-in page (/api/ms-start -> /api/ms-callback); we keep only its
// refresh token, AES-GCM encrypted in KV "mailbox_creds".
import { encryptSecret, decryptSecret } from "./_crypto.js";
import { hmacHex } from "./_billing.js";
import { extractCode } from "./_mime.js";

export const MS_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MS_SCOPE = "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read";
const CREDS_KEY = "mailbox_creds";
const ROTATE_AFTER_MS = 7 * 86400000;

export function redirectUri(request) {
  return new URL(request.url).origin + "/api/ms-callback";
}

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

export async function makeState(secret, data) {
  const p = b64url(JSON.stringify(Object.assign({ x: Date.now() + 20 * 60000 }, data)));
  return p + "." + (await hmacHex(secret, "ms-state:" + p));
}

export async function readState(secret, state) {
  const [p, sig] = String(state || "").split(".");
  if (!p || !sig) return null;
  const want = await hmacHex(secret, "ms-state:" + p);
  if (want.length !== sig.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (d) return null;
  try {
    const o = JSON.parse(unb64url(p));
    return o.x > Date.now() ? o : null;
  } catch (e) {
    return null;
  }
}

async function tokenRequest(env, params) {
  const body = new URLSearchParams(Object.assign({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: MS_SCOPE }, params));
  const r = await fetch(MS_AUTHORITY + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error(j.error === "invalid_grant" ? "reauth_needed" : "ms_token_error");
    e.detail = (j.error_description || j.error || "HTTP " + r.status).slice(0, 200);
    throw e;
  }
  return j;
}

export function exchangeCode(env, code, redirect) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirect });
}

export async function graphGet(accessToken, path, extraHeaders) {
  const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
    headers: Object.assign({ authorization: "Bearer " + accessToken }, extraHeaders || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status === 401 ? "reauth_needed" : "graph_error_" + r.status);
    e.detail = ((j.error && j.error.message) || "").slice(0, 200);
    throw e;
  }
  return j;
}

export async function saveGraphCreds(env, mailboxId, email, refreshToken) {
  const raw = await env.STATE_KV.get(CREDS_KEY);
  const store = raw ? JSON.parse(raw) : {};
  store[mailboxId] = {
    email,
    provider: "OUTLOOK_GRAPH",
    enc: await encryptSecret(refreshToken, env.ADMIN_SECRET),
    rtAt: Date.now(),
    savedAt: Date.now(),
  };
  await env.STATE_KV.put(CREDS_KEY, JSON.stringify(store));
}

// Fresh access token for a stored mailbox. Microsoft rotates refresh tokens;
// the old one keeps working, so the new one is written back only once a week
// (KV free tier allows 1,000 writes/day).
export async function graphAccessToken(env, creds, mailboxId) {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) throw new Error("ms_not_configured");
  let rt;
  try {
    rt = await decryptSecret(creds.enc, env.ADMIN_SECRET);
  } catch (e) {
    throw new Error("decrypt_failed");
  }
  const j = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: rt });
  if (j.refresh_token && j.refresh_token !== rt && Date.now() - (creds.rtAt || 0) > ROTATE_AFTER_MS) {
    try {
      await saveGraphCreds(env, mailboxId, creds.email, j.refresh_token);
    } catch (e) {
      /* keep using the old token */
    }
  }
  return j.access_token;
}

function htmlToText(s) {
  return String(s || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

// Newest Netflix emails across Inbox + Junk, newest first.
export async function graphNetflixMessages(accessToken, limit) {
  const sel = "$top=25&$orderby=receivedDateTime%20desc&$select=subject,from,receivedDateTime,toRecipients,body";
  const pref = { prefer: 'outlook.body-content-type="text"' };
  const folders = ["inbox", "junkemail"];
  let all = [];
  for (const f of folders) {
    try {
      const j = await graphGet(accessToken, "/me/mailFolders/" + f + "/messages?" + sel, pref);
      all = all.concat(j.value || []);
    } catch (e) {
      if (f === "inbox") throw e;
    }
  }
  return all
    .filter((m) => /netflix/i.test(((m.from && m.from.emailAddress && m.from.emailAddress.address) || "") + " " + ((m.from && m.from.emailAddress && m.from.emailAddress.name) || "")))
    .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime))
    .slice(0, limit || 1)
    .map((m) => {
      const text = htmlToText((m.body && m.body.content) || "");
      return {
        code: extractCode(text),
        subject: m.subject || "",
        date: m.receivedDateTime || "",
        to: ((m.toRecipients || [])[0] || { emailAddress: {} }).emailAddress.address || "",
      };
    });
}
