import { imapNewestUids, imapFetchHeaders, imapSearchNetflixUids } from "./_imap.js";
import { headerSummary } from "./_mime.js";

const RECENT_WINDOW = 25;

// Newest-first UIDs of Netflix mails (optionally only those delivered to
// `deliveredTo`, e.g. shop+acc1@gmail.com). Checks the newest messages
// directly by their headers first, so a code that arrived seconds ago is
// found even before Gmail's search index has it, then adds older matches
// from a normal search.
export async function findNetflixUids(client, exists, deliveredTo, limit) {
  const want = deliveredTo ? deliveredTo.toLowerCase() : null;
  const found = new Set();
  const recent = await imapNewestUids(client, exists, RECENT_WINDOW);
  for (let i = recent.length - 1; i >= 0 && found.size < limit; i--) {
    const raw = await imapFetchHeaders(client, recent[i]);
    if (!raw) continue;
    const h = headerSummary(raw);
    if (h.from.indexOf("netflix") < 0) continue;
    if (want && h.deliveredTo.indexOf(want) < 0) continue;
    found.add(recent[i]);
  }
  if (found.size < limit) {
    const searched = await imapSearchNetflixUids(client, deliveredTo);
    for (let i = searched.length - 1; i >= 0 && found.size < limit; i--) found.add(searched[i]);
  }
  return Array.from(found).sort((a, b) => b - a).slice(0, limit);
}
