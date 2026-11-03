// AES-256-GCM encrypt/decrypt for mailbox app-passwords at rest, keyed from
// ADMIN_SECRET (the same Pages secret used to sign admin auth tokens).
//
// This is defense-in-depth: the KV key these values live under
// ("mailbox_creds") is never read by the public /api/state endpoint and is
// only ever written/read through auth-gated routes — but encrypting the
// password bytes means a raw KV dump alone still isn't enough to read them.

async function deriveKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain, secret) {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  let bin = "";
  for (let i = 0; i < combined.length; i++) bin += String.fromCharCode(combined[i]);
  return btoa(bin);
}

export async function decryptSecret(encoded, secret) {
  const key = await deriveKey(secret);
  const bin = atob(encoded);
  const combined = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) combined[i] = bin.charCodeAt(i);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}
