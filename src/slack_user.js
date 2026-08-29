"use strict";

/**
 * "💬 Slack needs you" App Home section: READ-ONLY surfacing, now RANKED
 * (leadership first, direct questions next, then age — see the ranking
 * helpers below) with a one-line "why this matters" per item and a
 * "📥 Capture as task" button that queues a triage_add delegation entry.
 *
 * Uses an OPTIONAL user-authorized token (SLACK_USER_TOKEN, xoxp-…) that
 * Gustavo installs himself with minimal read scopes — `search:read`,
 * `im:read`, `im:history`, plus `channels:history` + `groups:history` for
 * thread-following (steps in SETUP.md). Without it the section renders a
 * "not configured" note and no Slack call is made; the bot runs exactly as
 * before.
 *
 * THREAD-FOLLOWING: besides mentions and unread DMs, the scan surfaces
 * replies in threads Gustavo participates in even when they don't @-mention
 * him — his recent messages (search.messages `from:<@me>`) yield candidate
 * (channel, thread_ts) pairs, conversations.replies fetches what landed
 * after his last word in each, and only threads where someone else replied
 * and he hasn't answered pass the filter. Items are deduped against the
 * mention/DM lists and ranked by the same tier pipeline.
 *
 * HONEST LIMITATION: Slack's Web API has no bulk mark-as-read / bulk-clean
 * for a user's inbox (conversations.mark is per-channel and gated, and
 * there is no "archive all" at all), so unlike the Gmail section this one
 * only SURFACES what needs attention — clicking through is the cleanup.
 */

// Same override-for-tests pattern as server.js; leave unset in production.
const SLACK_API_BASE = process.env.SLACK_API_BASE || "https://slack.com/api";

// How many DM conversations one pass checks for unreads (each costs one
// conversations.info call), and how many items each list shows.
const DM_SCAN_LIMIT = Math.min(200, Math.max(1, Number(process.env.SLACK_DM_SCAN_LIMIT) || 60));
const SHOWN_LIMIT = 5;
const INFO_CONCURRENCY = 5;

// Only mentions from the last N days count as "needs you". Thread-following
// reuses the same window for "his recent messages".
const MENTION_WINDOW_DAYS = 3;

const MENTION_TEXT_MAX = 90;

// Thread-following limits: how many unique threads one pass follows (each
// costs one conversations.replies call), how many of his own recent messages
// seed the candidate list, and how many replies per thread are inspected.
const THREAD_SCAN_LIMIT = Math.min(50, Math.max(1, Number(process.env.SLACK_THREAD_SCAN_LIMIT) || 20));
const THREAD_SEED_COUNT = 50;
const THREAD_REPLIES_LIMIT = 50;

// ---------------------------------------------------------------------------
// Ranking. Surfaced items are ordered leadership-first (name fragments from
// SLACK_LEADERSHIP_NAMES, comma-separated, defaulting to "ben"), then direct
// questions, then by age (newest first) — and each carries a one-line "why
// this matters" so the list explains its own order.
// ---------------------------------------------------------------------------

const LEADERSHIP_NAME_FRAGMENTS = (process.env.SLACK_LEADERSHIP_NAMES || "ben")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

/** True when a display name matches one of the leadership name fragments. */
function isLeadershipName(name) {
  const lower = String(name || "").toLowerCase();
  return LEADERSHIP_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

// A mention that reads like it's waiting on an answer from Gustavo.
const DIRECT_QUESTION_RE = /\?|can you|could you|would you|please|need(s)? (you|your)|what do you think|thoughts/i;

/**
 * Attaches {tier, why} to one mention: tier 0 leadership, 1 direct question,
 * 2 everything else. `why` is the one-line "why this matters" rendered under
 * the item.
 */
function classifyMention(mention) {
  if (isLeadershipName(mention.from)) {
    return { tier: 0, why: "leadership ping — answer first" };
  }
  if (DIRECT_QUESTION_RE.test(mention.text || "")) {
    return { tier: 1, why: "direct question waiting on you" };
  }
  return { tier: 2, why: "recent mention" };
}

/** Sorts classified items: tier ascending, then newest first. */
function byTierThenNewest(a, b) {
  return a.tier - b.tier || (Number(b.ts) || 0) - (Number(a.ts) || 0);
}

// ---------------------------------------------------------------------------
// Thread-following helpers (pure — no Slack calls, unit-testable as-is).
// ---------------------------------------------------------------------------

/**
 * Extracts the thread_ts from a Slack message permalink (replies carry
 * `?thread_ts=…` in their permalink; top-level messages don't). Returns the
 * ts string or null.
 */
function parseThreadTs(permalink) {
  const match = /[?&]thread_ts=(\d+\.\d+)/.exec(String(permalink || ""));
  return match ? match[1] : null;
}

/**
 * True when `text` names the user in plain words ("gustavo can you…")
 * WITHOUT a real <@U…> tag — the case the mention search can't see.
 * `nameFragments` are lowercase fragments (handle, first name).
 */
function mentionsNameWithoutTag(text, nameFragments) {
  // Strip real <@U…> tags first so only plain-word name uses count.
  const lower = String(text || "").replace(/<@[^>]*>/g, " ").toLowerCase();
  return (nameFragments || []).some((fragment) => fragment && lower.includes(fragment));
}

/**
 * Strong filter + tiering for one followed thread. `thread` is
 * { from, text, ts, repliesAfterUser } where from/text/ts describe the
 * NEWEST reply after the user's last message. Returns null when the thread
 * shouldn't be surfaced, else {tier, why} feeding the same ranking pipeline
 * as mentions (leadership 0, direct question / plain name-ping 1, else 2).
 */
function classifyThreadReply(thread, nameFragments) {
  if (!thread || !(thread.repliesAfterUser > 0)) return null; // he had the last word
  if (isLeadershipName(thread.from)) {
    return { tier: 0, why: `reply in your thread from ${thread.from} — leadership, unanswered` };
  }
  if (DIRECT_QUESTION_RE.test(thread.text || "")) {
    return { tier: 1, why: `reply in your thread from ${thread.from} — question, unanswered` };
  }
  if (mentionsNameWithoutTag(thread.text, nameFragments)) {
    return { tier: 1, why: `reply in your thread from ${thread.from} — names you, unanswered` };
  }
  return { tier: 2, why: `reply in your thread from ${thread.from}, unanswered` };
}

/** True when the optional user token is set. */
function isConfigured() {
  return Boolean(process.env.SLACK_USER_TOKEN);
}

/** GET a Slack Web API method with the USER token; throws on !ok. */
async function slackUserGet(method, params) {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`${SLACK_API_BASE}/${method}${query}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` },
  });
  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.error || `HTTP ${response.status}`}`);
  }
  return json;
}

/**
 * Thread-following: finds threads the user participates in with unanswered
 * replies from others. His own recent messages (search.messages
 * `from:<@me>`, last MENTION_WINDOW_DAYS days) seed unique
 * (channel, thread_ts) candidates — thread_ts parsed from the reply
 * permalink, else the message itself as a possible thread root — capped at
 * THREAD_SCAN_LIMIT. conversations.replies (needs channels:history /
 * groups:history on the user token) then yields what landed after his last
 * message; classifyThreadReply() keeps only unanswered threads and tiers
 * them for the shared ranking pipeline. Items whose newest reply is already
 * a surfaced mention (skipTs) or that live in a surfaced unread DM
 * (skipChannels) are deduped away. Per-thread failures (for example a
 * missing history scope) are logged and skipped; only the seed search can
 * throw.
 *
 * @param {string} userId - the token owner's user id (auth.test)
 * @param {string} teamUrl - workspace base URL with trailing slash
 * @param {Array<string>} nameFragments - lowercase name fragments for
 *   plain-word "names you" detection
 * @param {Set<string>} skipTs - ts values already surfaced as mentions
 * @param {Set<string>} skipChannels - channel ids already surfaced as DMs
 * @returns {Promise<Array<object>>} ranked thread items (top SHOWN_LIMIT)
 */
async function getThreadItems(userId, teamUrl, nameFragments, skipTs, skipChannels) {
  const search = await slackUserGet("search.messages", {
    query: `from:<@${userId}>`,
    sort: "timestamp",
    sort_dir: "desc",
    count: String(THREAD_SEED_COUNT),
  });
  const cutoff = (Date.now() - MENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000;

  const candidates = [];
  const seenThreads = new Set();
  for (const m of ((search.messages || {}).matches) || []) {
    if (!m || Number(m.ts) < cutoff) continue;
    const channelId = m.channel && m.channel.id;
    if (!channelId) continue;
    const threadTs = parseThreadTs(m.permalink) || m.ts; // reply, or possible root
    const key = `${channelId}:${threadTs}`;
    if (seenThreads.has(key)) continue;
    seenThreads.add(key);
    candidates.push({
      channelId,
      threadTs,
      seedTs: m.ts,
      channelName: (m.channel && m.channel.name) || null,
    });
    if (candidates.length >= THREAD_SCAN_LIMIT) break;
  }

  const items = [];
  const nameCache = new Map();
  for (let i = 0; i < candidates.length; i += INFO_CONCURRENCY) {
    const batch = await Promise.all(
      candidates.slice(i, i + INFO_CONCURRENCY).map((candidate) =>
        slackUserGet("conversations.replies", {
          channel: candidate.channelId,
          ts: candidate.threadTs,
          limit: String(THREAD_REPLIES_LIMIT),
        })
          .then((json) => ({ candidate, messages: json.messages || [] }))
          .catch((err) => {
            console.error(`conversations.replies ${candidate.channelId}/${candidate.threadTs} failed:`, err);
            return null;
          })
      )
    );
    for (const result of batch) {
      if (!result || result.messages.length < 2) continue; // not a thread
      const { candidate, messages } = result;
      if (skipChannels.has(candidate.channelId)) continue; // already an unread DM

      // Replies newer than his LAST message in the thread, from other humans.
      let hisLastTs = Number(candidate.seedTs) || 0;
      for (const msg of messages) {
        if (msg && msg.user === userId && Number(msg.ts) > hisLastTs) hisLastTs = Number(msg.ts);
      }
      const repliesAfter = messages.filter(
        (msg) => msg && msg.user && msg.user !== userId && Number(msg.ts) > hisLastTs
      );
      if (repliesAfter.length === 0) continue; // he had the last word
      const newest = repliesAfter[repliesAfter.length - 1];
      if (skipTs.has(newest.ts)) continue; // already surfaced as a mention

      let from = newest.user;
      if (nameCache.has(newest.user)) {
        from = nameCache.get(newest.user);
      } else {
        try {
          const user = await slackUserGet("users.info", { user: newest.user });
          from = (user.user && (user.user.real_name || user.user.name)) || from;
        } catch (err) {
          // users:read may not be granted - the raw id is fine.
        }
        nameCache.set(newest.user, from);
      }

      const item = {
        text: (newest.text || "").replace(/\s+/g, " ").trim(),
        permalink: `${teamUrl}archives/${candidate.channelId}/p${String(newest.ts).replace(".", "")}?thread_ts=${candidate.threadTs}&cid=${candidate.channelId}`,
        from,
        channel: candidate.channelName,
        ts: newest.ts,
        repliesAfterUser: repliesAfter.length,
      };
      const classified = classifyThreadReply(item, nameFragments);
      if (classified) items.push({ ...item, ...classified });
    }
  }

  return items.sort(byTierThenNewest).slice(0, SHOWN_LIMIT);
}

/**
 * Fetches the section data with the user token:
 *   - mentions: recent messages mentioning <@me> (search.messages, newest
 *     first, others' messages only, last MENTION_WINDOW_DAYS days)
 *   - dms: DM conversations with unreads (conversations.list types=im,
 *     newest-updated first, top DM_SCAN_LIMIT checked via conversations.info)
 *   - threads: replies in threads he participates in that he hasn't answered
 *     (getThreadItems above), deduped against the two lists before it
 * Never throws: returns { configured: false } when unconfigured, or
 * { configured: true, error } on failure. A thread-following failure (for
 * example the token lacking channels:history) degrades to threads: [] and a
 * log line — mentions and DMs still render.
 */
async function getHomeData() {
  if (!isConfigured()) return { configured: false };
  try {
    const auth = await slackUserGet("auth.test");
    const userId = auth.user_id;
    const teamUrl = (auth.url || "https://slack.com/").replace(/\/?$/, "/");

    // --- Unread mentions (last few days, other people's messages only) ------
    const search = await slackUserGet("search.messages", {
      query: `<@${userId}>`,
      sort: "timestamp",
      sort_dir: "desc",
      count: "20",
    });
    const cutoff = (Date.now() - MENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000;
    const mentions = (((search.messages || {}).matches) || [])
      .filter((m) => m && m.user !== userId && Number(m.ts) >= cutoff)
      .map((m) => {
        const mention = {
          text: (m.text || "").replace(/\s+/g, " ").trim(),
          permalink: m.permalink || null,
          from: m.username || "someone",
          channel: (m.channel && m.channel.name) || null,
          ts: m.ts,
        };
        return { ...mention, ...classifyMention(mention) };
      })
      .sort(byTierThenNewest)
      .slice(0, SHOWN_LIMIT);

    // --- Unread DMs ----------------------------------------------------------
    // conversations.list gives no unread counts, so the most recently updated
    // DMs are checked individually via conversations.info (which returns
    // unread_count_display for the authed user).
    const list = await slackUserGet("conversations.list", {
      types: "im",
      exclude_archived: "true",
      limit: "200",
    });
    const candidates = (list.channels || [])
      .filter((c) => c && c.id && !c.is_user_deleted)
      .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
      .slice(0, DM_SCAN_LIMIT);

    const dms = [];
    const dmChannelIds = [];
    for (let i = 0; i < candidates.length && dms.length < SHOWN_LIMIT; i += INFO_CONCURRENCY) {
      const batch = await Promise.all(
        candidates.slice(i, i + INFO_CONCURRENCY).map((c) =>
          slackUserGet("conversations.info", { channel: c.id }).catch((err) => {
            console.error(`conversations.info ${c.id} failed:`, err);
            return null;
          })
        )
      );
      for (const info of batch) {
        const channel = info && info.channel;
        if (!channel || !(channel.unread_count_display > 0)) continue;
        let name = channel.user || "unknown";
        try {
          const user = await slackUserGet("users.info", { user: channel.user });
          name = (user.user && (user.user.real_name || user.user.name)) || name;
        } catch (err) {
          // users:read may not be granted - the raw id is fine.
        }
        const leadership = isLeadershipName(name);
        dmChannelIds.push(channel.id);
        dms.push({
          name,
          unread: channel.unread_count_display,
          link: `${teamUrl}archives/${channel.id}`,
          tier: leadership ? 0 : 2,
          why: leadership ? "leadership DM — answer first" : "unread DM",
        });
        if (dms.length >= SHOWN_LIMIT) break;
      }
    }
    dms.sort((a, b) => a.tier - b.tier || b.unread - a.unread);

    // --- Threads he participates in, with unanswered replies ------------------
    // Deduped against the mention/DM lists above. A failure here (for
    // example the token lacking channels:history) degrades to threads: []
    // with a log line — mentions and DMs still render.
    let threads = [];
    try {
      const selfNameFragments = [String(auth.user || "").toLowerCase().trim()].filter(Boolean);
      threads = await getThreadItems(
        userId,
        teamUrl,
        selfNameFragments,
        new Set(mentions.map((m) => m.ts)),
        new Set(dmChannelIds)
      );
    } catch (err) {
      console.error("Slack thread-following fetch failed:", err);
    }

    return { configured: true, mentions, dms, threads };
  } catch (err) {
    console.error("Slack needs-you fetch failed:", err);
    return { configured: true, error: err.message };
  }
}

/** Escapes chars that would break an mrkdwn <url|label> link label. */
function linkLabel(text, max) {
  let label = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "¦");
  if (label.length > max) label = `${label.slice(0, max - 1)}…`;
  return label;
}

/**
 * Builds the "💬 Slack needs you" Home blocks from getHomeData()'s result:
 * a "not configured" note when the user token is absent, a warning line on
 * fetch errors, otherwise the recent-mentions, thread-replies and unread-DM
 * lists plus an honest read-only footnote.
 *
 * @param {object|null|undefined} data - getHomeData() result
 * @returns {Array<object>}
 */
function buildNeedsYouBlocks(data) {
  const blocks = [
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "💬 Slack needs you", emoji: true } },
  ];

  if (!data || !data.configured) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Not configured — set `SLACK_USER_TOKEN` with read scopes (see SETUP.md).",
        },
      ],
    });
    return blocks;
  }

  if (data.error) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `⚠️ Slack needs-you fetch failed: ${linkLabel(data.error, 200)}` }],
    });
    return blocks;
  }

  const mentions = Array.isArray(data.mentions) ? data.mentions : [];
  const dms = Array.isArray(data.dms) ? data.dms : [];
  const threads = Array.isArray(data.threads) ? data.threads : [];

  if (mentions.length === 0 && dms.length === 0 && threads.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "✨ Nothing needs you right now." },
    });
  } else {
    if (mentions.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Recent mentions* (ranked):" },
      });
      mentions.forEach((m, index) => {
        const label = linkLabel(m.text, MENTION_TEXT_MAX);
        const where = m.channel ? ` — #${m.channel}` : "";
        blocks.push({
          type: "section",
          block_id: `needsyou_m_${index}`,
          text: {
            type: "mrkdwn",
            text: `🔔 ${m.permalink ? `<${m.permalink}|${label}>` : label} (${linkLabel(m.from, 30)}${where})\n_→ ${m.why}_`,
          },
          accessory: buildCaptureButton(`Reply to ${m.from}: ${m.text}`, m.permalink),
        });
      });
    }
    if (threads.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Replies in your threads* (ranked):" },
      });
      threads.forEach((t, index) => {
        const label = linkLabel(t.text, MENTION_TEXT_MAX);
        const where = t.channel ? ` — #${t.channel}` : "";
        blocks.push({
          type: "section",
          block_id: `needsyou_t_${index}`,
          text: {
            type: "mrkdwn",
            text: `🧵 ${t.permalink ? `<${t.permalink}|${label}>` : label} (${linkLabel(t.from, 30)}${where})\n_→ ${t.why}_`,
          },
          accessory: buildCaptureButton(`Reply in thread to ${t.from}: ${t.text}`, t.permalink),
        });
      });
    }
    if (dms.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Unread DMs* (ranked):" },
      });
      dms.forEach((d, index) => {
        blocks.push({
          type: "section",
          block_id: `needsyou_d_${index}`,
          text: {
            type: "mrkdwn",
            text: `✉️ <${d.link}|${linkLabel(d.name, 40)}> — ${d.unread} unread\n_→ ${d.why}_`,
          },
          accessory: buildCaptureButton(`Reply to ${d.name}'s DM (${d.unread} unread)`, d.link),
        });
      });
    }
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Read-only surfacing: Slack's API doesn't support bulk-cleaning your inbox — open each item to handle it, or 📥 Capture it as a triage task.",
      },
    ],
  });

  return blocks;
}

// Capture-button value text cap (same convention as home.js task values).
const CAPTURE_TEXT_MAX = 140;

/**
 * "📥 Capture as task" accessory (action_id `needsyou_capture`). Clicking
 * queues a "triage_add" delegation entry — same type the "Add to Triage"
 * message shortcut produces, so the agent-side drain handles both
 * identically. Value carries {text (truncated), link}.
 *
 * @param {string} text
 * @param {string|null} link
 * @returns {object} Slack Block Kit button element
 */
function buildCaptureButton(text, link) {
  const value = { text: String(text || "").slice(0, CAPTURE_TEXT_MAX) };
  if (typeof link === "string" && link) value.link = link;
  return {
    type: "button",
    action_id: "needsyou_capture",
    text: { type: "plain_text", text: "📥 Capture as task", emoji: true },
    value: JSON.stringify(value),
  };
}

module.exports = {
  isConfigured,
  getHomeData,
  buildNeedsYouBlocks,
  // Pure thread-following helpers, exported for tests.
  parseThreadTs,
  mentionsNameWithoutTag,
  classifyThreadReply,
};
