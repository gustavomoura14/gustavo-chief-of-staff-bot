"use strict";

/**
 * Gmail cleanup integration for the App Home.
 *
 * The bot talks to the Gmail REST API directly (plain fetch, no SDK) using
 * standard Google OAuth configuration supplied via env vars:
 *   - GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET: an OAuth client Gustavo creates
 *   - GMAIL_REFRESH_TOKEN: a refresh token he mints himself through Google's
 *     normal consent flow (steps in SETUP.md)
 * When ANY of the three is missing, isConfigured() is false, the Home
 * section renders a "not connected" note with no buttons, and no Gmail
 * request is ever made — the bot runs exactly as before.
 *
 * Triage heuristics (per thread, across all its messages):
 *   - starred: any message carries STARRED
 *   - replied: any message carries SENT (Gustavo wrote in the thread)
 *   - promo:   any CATEGORY_PROMOTIONS/SOCIAL/UPDATES/FORUMS label, a
 *              List-Unsubscribe header, Precedence bulk/list, or a
 *              no-reply-style sender
 *   - low-priority = promo AND NOT starred AND NOT replied
 *   - everything else is "important"; starred, then unread, then newest
 *     bubble to the top
 *
 * SAFETY INVARIANTS (enforced in code, not just documented):
 *   - the ONLY mutations in this module are threads.modify
 *     { removeLabelIds: ["INBOX"] } (archive) and drafts.create (writes a
 *     DRAFT into Gustavo's Drafts folder — see createDraft). There is no
 *     code path that trashes, deletes, spams, or SENDS anything: sending is
 *     always Gustavo's own manual act, from Gmail.
 *   - starred threads and threads Gustavo replied to are NEVER archived:
 *     they are excluded from the low-priority bucket at triage time AND
 *     re-checked immediately before each modify call in
 *     archiveLowPriority().
 */

// Overridable ONLY so local tests can point at a mock server (same pattern
// as SLACK_API_BASE in server.js); leave unset in production.
const GMAIL_API_BASE = process.env.GMAIL_API_BASE || "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";

// How many inbox threads one triage pass inspects (each costs one metadata
// GET, so keep this modest; 1-100).
const SCAN_LIMIT = Math.min(100, Math.max(1, Number(process.env.GMAIL_SCAN_LIMIT) || 50));

// Metadata GETs run in small parallel batches to keep triage snappy without
// hammering the API.
const FETCH_CONCURRENCY = 5;

// How many important threads the Home section lists.
const IMPORTANT_SHOWN = 5;

const NO_REPLY_SENDER = /no-?reply|do-?not-?reply|noreply|notifications?@/i;
const PROMO_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

/** True when all three Gmail OAuth env vars are set. */
function isConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN
  );
}

// Access-token cache: { token, expiresAt (ms) }. Refresh tokens are
// long-lived; access tokens last ~1h and are re-minted 60s early.
let tokenCache = null;

/** Exchanges the refresh token for an access token (cached until expiry). */
async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`Gmail token refresh failed: ${json.error || `HTTP ${response.status}`}`);
  }
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
  };
  return tokenCache.token;
}

/** Authorized GET against the Gmail API; throws on non-ok responses. */
async function gmailGet(pathname, params) {
  const token = await getAccessToken();
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`${GMAIL_API_BASE}${pathname}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gmail GET ${pathname} failed: ${(json.error && json.error.message) || `HTTP ${response.status}`}`);
  }
  return json;
}

/** Authorized POST against the Gmail API; throws on non-ok responses. */
async function gmailPost(pathname, body) {
  const token = await getAccessToken();
  const response = await fetch(`${GMAIL_API_BASE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gmail POST ${pathname} failed: ${(json.error && json.error.message) || `HTTP ${response.status}`}`);
  }
  return json;
}

/** Reads one header value (case-insensitive) from a metadata message. */
function header(message, name) {
  const headers = (message.payload && message.payload.headers) || [];
  const match = headers.find((h) => h && h.name && h.name.toLowerCase() === name.toLowerCase());
  return match ? match.value : "";
}

/**
 * Classifies one thread (fetched with format=metadata) into the summary
 * shape the Home section and the archiver share.
 *
 * @param {object} thread - Gmail threads.get response
 * @returns {{id: string, subject: string, from: string, unread: boolean,
 *            starred: boolean, replied: boolean, promo: boolean,
 *            lastMs: number}}
 */
function classifyThread(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  let starred = false;
  let replied = false;
  let promo = false;
  let unread = false;
  let lastMs = 0;
  let subject = "";
  let from = "";

  messages.forEach((message) => {
    const labels = new Set(message.labelIds || []);
    if (labels.has("STARRED")) starred = true;
    if (labels.has("SENT")) replied = true;
    if (labels.has("UNREAD")) unread = true;
    for (const label of labels) {
      if (PROMO_LABELS.has(label)) promo = true;
    }
    if (header(message, "List-Unsubscribe")) promo = true;
    if (/^(bulk|list)/i.test(header(message, "Precedence"))) promo = true;

    const ms = Number(message.internalDate) || 0;
    if (ms >= lastMs) {
      lastMs = ms;
      if (!labels.has("SENT")) {
        from = header(message, "From") || from;
      }
    }
    if (!subject) subject = header(message, "Subject");
    if (!from) from = header(message, "From");
    if (NO_REPLY_SENDER.test(header(message, "From"))) promo = true;
  });

  return {
    id: thread.id,
    subject: subject || "(no subject)",
    from,
    unread,
    starred,
    replied,
    promo,
    lastMs,
  };
}

/**
 * Triages the inbox: lists up to SCAN_LIMIT threads with the INBOX label,
 * fetches each thread's metadata, and splits them into `important` (sorted
 * starred > unread > newest) and `lowPriority` (promo/list/no-reply threads
 * that are neither starred nor replied-to — the only archive candidates).
 *
 * @returns {Promise<{important: Array<object>, lowPriority: Array<object>,
 *                    scanned: number}>}
 */
async function triageInbox() {
  const list = await gmailGet("/users/me/threads", {
    q: "in:inbox",
    maxResults: String(SCAN_LIMIT),
  });
  const ids = (list.threads || []).map((t) => t.id).filter(Boolean);

  const classified = [];
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(i, i + FETCH_CONCURRENCY).map((id) =>
        // format=metadata: labels + headers, no bodies (all headers returned
        // when metadataHeaders is unspecified).
        gmailGet(`/users/me/threads/${id}`, { format: "metadata" }).catch((err) => {
          console.error(`Gmail thread ${id} metadata fetch failed:`, err);
          return null;
        })
      )
    );
    batch.forEach((thread) => {
      if (thread) classified.push(classifyThread(thread));
    });
  }

  const important = classified.filter((t) => !(t.promo && !t.starred && !t.replied));
  const lowPriority = classified.filter((t) => t.promo && !t.starred && !t.replied);
  important.sort(
    (a, b) =>
      Number(b.starred) - Number(a.starred) ||
      Number(b.unread) - Number(a.unread) ||
      b.lastMs - a.lastMs
  );

  return { important, lowPriority, scanned: classified.length };
}

/**
 * Archives every low-priority thread by removing its INBOX label — the sole
 * mutation this module performs. Runs a FRESH triage (button values are
 * never trusted to carry thread ids) and re-checks the starred/replied
 * invariants per thread before each modify call. Never trashes or deletes.
 *
 * @returns {Promise<{archived: number, skipped: number}>}
 */
async function archiveLowPriority() {
  const { lowPriority } = await triageInbox();
  let archived = 0;
  let skipped = 0;
  for (const thread of lowPriority) {
    // Invariant re-check: starred/replied threads are never archived, even
    // if a classification bug ever let one into the low-priority bucket.
    if (thread.starred || thread.replied) {
      skipped += 1;
      continue;
    }
    await gmailPost(`/users/me/threads/${thread.id}/modify`, {
      removeLabelIds: ["INBOX"],
    });
    archived += 1;
  }
  return { archived, skipped };
}

/** RFC 2047-encodes a header value when it carries non-ASCII characters. */
function encodeHeaderValue(value) {
  const text = String(value == null ? "" : value);
  if (!/[^\x20-\x7e]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * Creates a REAL Gmail draft (users.drafts.create) from plain to/subject/body
 * fields. The draft lands in Gustavo's Drafts folder for him to review, edit
 * and send HIMSELF — this module contains no send call of any kind.
 *
 * @param {{to: string, subject?: string, body: string}} draft
 * @returns {Promise<{id: string, messageId: string|null}>} the Gmail draft id
 *   plus the draft message's id (used to deep-link straight to the draft)
 */
async function createDraft({ to, subject, body }) {
  const raw = Buffer.from(
    [
      `To: ${String(to)}`,
      `Subject: ${encodeHeaderValue(subject || "")}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
      "",
      String(body == null ? "" : body),
    ].join("\r\n"),
    "utf8"
  ).toString("base64url");

  const json = await gmailPost("/users/me/drafts", { message: { raw } });
  return { id: json.id, messageId: (json.message && json.message.id) || null };
}

/**
 * Fetches the Home-section data. Never throws: returns
 * { configured: false } when the env vars are absent (no request made), or
 * { configured: true, error } when triage fails.
 */
async function getHomeData() {
  if (!isConfigured()) return { configured: false };
  try {
    const triage = await triageInbox();
    return { configured: true, ...triage };
  } catch (err) {
    console.error("Gmail triage failed:", err);
    return { configured: true, error: err.message };
  }
}

/** Escapes Slack mrkdwn control chars so subjects/senders render verbatim. */
function escapeMrkdwn(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SUBJECT_MAX = 90;
const FROM_MAX = 40;

/** Gmail deep link for one thread ("#all" so archived threads still open). */
function threadLink(id) {
  return `https://mail.google.com/mail/u/0/#all/${id}`;
}

/**
 * Builds the "📧 Gmail cleanup" Home blocks from getHomeData()'s result:
 * a "not connected" note when unconfigured, a warning line on triage
 * errors, otherwise the top important threads plus one "🗑️ Archive N
 * low-priority" button (action_id `gmail_archive_low`, section block_id
 * `gmail_low` so the click handler can rewrite it in place).
 *
 * @param {object|null|undefined} data - getHomeData() result
 * @returns {Array<object>}
 */
function buildGmailBlocks(data) {
  const blocks = [
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "📧 Gmail cleanup", emoji: true } },
  ];

  if (!data || !data.configured) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Not connected — set `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` (see SETUP.md).",
        },
      ],
    });
    return blocks;
  }

  if (data.error) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `⚠️ Gmail triage failed: ${escapeMrkdwn(data.error)}` }],
    });
    return blocks;
  }

  const important = Array.isArray(data.important) ? data.important : [];
  const lowPriority = Array.isArray(data.lowPriority) ? data.lowPriority : [];

  if (important.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "✨ Nothing important waiting in the inbox." },
    });
  } else {
    const lines = important.slice(0, IMPORTANT_SHOWN).map((t) => {
      const icon = t.starred ? "⭐" : t.unread ? "🔵" : "▪️";
      let subject = escapeMrkdwn(t.subject);
      if (subject.length > SUBJECT_MAX) subject = `${subject.slice(0, SUBJECT_MAX - 1)}…`;
      let from = escapeMrkdwn(t.from);
      if (from.length > FROM_MAX) from = `${from.slice(0, FROM_MAX - 1)}…`;
      return `${icon} <${threadLink(t.id)}|${subject}> — ${from}`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Bubbled up (${important.length}):*\n${lines.join("\n")}` },
    });
    if (important.length > IMPORTANT_SHOWN) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `…and ${important.length - IMPORTANT_SHOWN} more — <https://mail.google.com/mail/u/0/#inbox|open the inbox>`,
          },
        ],
      });
    }
  }

  if (lowPriority.length > 0) {
    blocks.push({
      type: "section",
      block_id: "gmail_low",
      text: {
        type: "mrkdwn",
        text: `🧹 *${lowPriority.length} low-priority* (promos, lists, no-reply — none starred or replied-to)`,
      },
      accessory: {
        type: "button",
        action_id: "gmail_archive_low",
        text: {
          type: "plain_text",
          text: `🗑️ Archive ${lowPriority.length} low-priority`,
          emoji: true,
        },
        value: JSON.stringify({ type: "gmail_archive_low", count: lowPriority.length }),
      },
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Archive only removes threads from the inbox — nothing is ever deleted, and starred/replied threads are always kept.",
        },
      ],
    });
  } else {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "✨ No low-priority clutter detected." }],
    });
  }

  return blocks;
}

module.exports = {
  isConfigured,
  triageInbox,
  archiveLowPriority,
  createDraft,
  getHomeData,
  buildGmailBlocks,
  classifyThread,
};
