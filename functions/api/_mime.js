// Minimal MIME parsing + OTP-code extraction, scoped to what Netflix's own
// "sign-in code" / "temporary access code" / "household verification" emails
// actually look like — not a general-purpose MIME library.

function bytesToLatin1String(bytes) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function splitHeadersBody(text) {
  const idx = text.indexOf("\r\n\r\n");
  if (idx < 0) return { headersText: text, bodyText: "" };
  return { headersText: text.slice(0, idx), bodyText: text.slice(idx + 4) };
}

function parseHeaders(headersText) {
  const unfolded = headersText.replace(/\r\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r\n/);
  const headers = {};
  for (const line of lines) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
}

function decodeQuotedPrintable(s) {
  const joined = s.replace(/=\r\n/g, "").replace(/=\n/g, "");
  return joined.replace(/=([0-9A-Fa-f]{2})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

function decodeBase64ToText(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (e) {
    return "";
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function decodeRfc2047(s) {
  return String(s || "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (_, _charset, enc, data) {
    if (enc.toLowerCase() === "b") return decodeBase64ToText(data);
    return decodeQuotedPrintable(data.replace(/_/g, " "));
  });
}

function extractBoundary(contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || "");
  return m ? m[1] : null;
}

// Walks a (possibly multipart, possibly nested) MIME message and returns all
// decoded text parts (text/plain, and text/html with tags stripped) joined.
function collectTextParts(rawText, depth) {
  if (depth > 6) return "";
  const { headersText, bodyText } = splitHeadersBody(rawText);
  const headers = parseHeaders(headersText);
  const contentType = headers["content-type"] || "text/plain";
  const cte = (headers["content-transfer-encoding"] || "").toLowerCase().trim();

  if (/multipart\//i.test(contentType)) {
    const boundary = extractBoundary(contentType);
    if (!boundary) return "";
    const parts = bodyText.split("--" + boundary);
    let out = "";
    for (const part of parts) {
      const trimmed = part.replace(/^\r\n/, "");
      if (!trimmed || trimmed.trim() === "--" || trimmed.trim() === "") continue;
      out += collectTextParts(trimmed, depth + 1) + "\n";
    }
    return out;
  }

  let decodedBody = bodyText;
  if (cte === "base64") decodedBody = decodeBase64ToText(bodyText);
  else if (cte === "quoted-printable") decodedBody = decodeQuotedPrintable(bodyText);

  if (/text\/html/i.test(contentType)) return stripHtml(decodedBody);
  if (/text\//i.test(contentType) || !contentType) return decodedBody;
  return ""; // skip non-text parts (images, etc.)
}

function headerValue(rawText, name) {
  const { headersText } = splitHeadersBody(rawText);
  const headers = parseHeaders(headersText);
  return headers[name] || "";
}

// Looks for a 4-8 digit numeric OTP, preferring one that follows a
// recognisable "code" keyword (English or Thai), falling back to the first
// standalone digit run of plausible length anywhere in the text.
function extractCode(text) {
  const keywordPattern =
    /(?:sign-?in code|access code|verification code|security code|temporary code|household code|รหัสยืนยัน|รหัสผ่านชั่วคราว|โค้ด)\D{0,20}?(\d{4,8})/i;
  const kw = keywordPattern.exec(text);
  if (kw) return kw[1];
  const standalone = /\b(\d{4,8})\b/.exec(text);
  return standalone ? standalone[1] : null;
}

export function parseNetflixOtpEmail(rawBytes) {
  const rawText = bytesToLatin1String(rawBytes);
  const subject = decodeRfc2047(headerValue(rawText, "subject"));
  const date = headerValue(rawText, "date");
  const bodyAllText = collectTextParts(rawText, 0);
  const code = extractCode(subject) || extractCode(bodyAllText);
  return { code: code, subject: subject, date: date };
}
