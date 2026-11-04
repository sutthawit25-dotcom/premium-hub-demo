import { decryptSecret } from "./_crypto.js";

export const PROVIDER_HOSTS = {
  GMAIL: { host: "imap.gmail.com", port: 993 },
  OUTLOOK: { host: "outlook.office365.com", port: 993 },
};

// Resolves a stored mailbox-creds entry into the actual IMAP connection
// details to use for it.
//
// A normal GMAIL/OUTLOOK entry resolves directly. An OUTLOOK_FORWARD entry
// is a "virtual" mailbox: since Microsoft killed IMAP app-passwords for
// personal Outlook/Hotmail accounts, the admin instead sets up a normal
// Outlook.com forwarding rule (signed in through the browser, no Azure/app
// password involved) that forwards that account's Netflix mail to a real
// Gmail mailbox we already have working IMAP creds for, at a tagged address
// like shop+acct1@gmail.com. This follows sourceMailboxId to that real
// Gmail entry's creds and returns forwardTag as toTag, so the OTP search can
// filter the shared Gmail inbox down to just this forwarded account's mail.
export async function resolveMailboxImap(store, mailboxId, adminSecret) {
  const creds = store[mailboxId];
  if (!creds) return { error: "no_credentials" };

  if (creds.provider === "OUTLOOK_FORWARD") {
    const source = store[creds.sourceMailboxId];
    if (!source) return { error: "source_mailbox_missing" };
    const host = PROVIDER_HOSTS[source.provider];
    if (!host) return { error: "unsupported_provider" };
    let appPassword;
    try {
      appPassword = await decryptSecret(source.enc, adminSecret);
    } catch (e) {
      return { error: "decrypt_failed" };
    }
    // Full tagged address, e.g. shop+acc1@gmail.com (never just "acc1",
    // which would also match acc10).
    const at = String(source.email).lastIndexOf("@");
    const toTag = creds.forwardTag && at > 0
      ? (source.email.slice(0, at) + "+" + creds.forwardTag + source.email.slice(at)).toLowerCase()
      : null;
    return { host, email: source.email, appPassword, toTag };
  }

  const host = PROVIDER_HOSTS[creds.provider];
  if (!host) return { error: "unsupported_provider" };
  let appPassword;
  try {
    appPassword = await decryptSecret(creds.enc, adminSecret);
  } catch (e) {
    return { error: "decrypt_failed" };
  }
  return { host, email: creds.email, appPassword, toTag: null };
}
