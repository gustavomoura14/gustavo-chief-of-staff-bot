"use strict";

/**
 * "💬 Slack needs you" App Home section: READ-ONLY surfacing, now RANKED
 * (leadership first, direct questions next, then age — see the ranking
 * helpers below) with a one-line "why this matters" per item and a
 * "📥 Capture as task" button that queues a triage_add delegation entry.
 *
 * Uses an OPTIONAL user-authorized token (SLACK_USER_TOKEN, xoxp-…) that
 * Gustavo installs himself with minimal read scopes — `search:read`,
 * `im:read`, `im:history` (steps in SETUP.md). Without it the section
 * renders a "not configured" note and no Slack call is made; the bot runs
 * exactly as before.
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

// Only mentions from the last N days count as "needs you".
const MENTION_WINDOW_DAYS = 3;

const MENTION_TEXT_MAX = 90;

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
 * Fetches the section data with the user token:
 *   - mentions: recent messages mentioning <@me> (search.messages, newest
 *     first, others' messages only, last MENTION_WINDOW_DAYS days)
 *   - dms: DM conversations with unreads (conversations.list types=im,
 *     newest-updated first, top DM_SCAN_LIMIT checked via conversations.info)
 * Never throws: returns { configured: false } when unconfigured, or
 * { configured: true, error } on failure.
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

    return { configured: true, mentions, dms };
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
 * fetch errors, otherwise the recent-mentions and unread-DM lists plus an
 * honest read-only footnote.
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

  if (mentions.length === 0 && dms.length === 0) {
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
};
