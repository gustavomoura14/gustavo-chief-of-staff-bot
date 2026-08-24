"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const {
  buildBriefBlocks,
  buildRecommendationsBlocks,
  applyAction,
  RECOMMENDATIONS_TITLE,
  RECS_HEADER_BLOCK_ID,
  REC_TEXT_BLOCK_ID_PREFIX,
  SEC_ITEM_BLOCK_ID_PREFIX,
  SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX,
} = require("./blocks");
const { verifySlackSignature } = require("./verify");
const { buildHomeView } = require("./home");

const app = express();
const PORT = process.env.PORT || 3000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// Slack Web API base URL. Overridable ONLY so local tests can point at a
// mock server; leave unset in production.
const SLACK_API_BASE = process.env.SLACK_API_BASE || "https://slack.com/api";

// ---------------------------------------------------------------------------
// Delegation queue. Clicks push entries here; an external worker drains it
// via GET /delegations/pending and marks entries via POST /delegations/ack
// or POST /delegations/complete.
//
// Durability: the queue is held in memory AND mirrored to a JSON file
// (DATA_DIR env var, defaulting to the OS temp dir) on every mutation (push,
// ack, complete). On startup the file, if present, is loaded back - so plain
// process restarts/crashes no longer drop queued clicks. Residual risk: a
// full instance re-provision (e.g. Render free tier moving the service to a
// fresh filesystem) still loses the file - see README.
//
// Every entry has { id, type, clickedAt, status } where status is
// "pending" | "done" | "failed" (acks may also attach `note`/`ackedAt`) and
// `type` is one of:
//   - "calendar"      (🤖 Do it on a brief recommendation): + itemId, text,
//                     link, channel, message_ts (channel/message_ts identify
//                     the original brief message for /delegations/complete)
//   - "task_complete" (✅ Complete on a Home-tab triage row): + taskId, text,
//                     source, link
//   - "bot_do"        (🤖 Do it on a Home-tab triage row): shaped
//                     { id: "botdo-<ms>", type, task_id, text, link, source,
//                     clickedAt, status }
//   - "gmail_zero_start" / "slack_zero_start" (🧹 Start sweep on a Home-tab
//                     🎯 Projects row): shaped { id: "gmailzero-<ms>" /
//                     "slackzero-<ms>", type, clickedAt, status }
//   - "triage_add"    ("Add to Triage" message shortcut): + text, channel,
//                     message_ts, permalink
//   - "delegated_to"  (🙋 "Delegate to..." users_select on a brief
//                     recommendation OR a Home-tab triage row): shaped
//                     { id: "delegated-<ms>", type, text, link, to_user_id
//                     (the selected Slack user id), clickedAt, status,
//                     channel, message_ts } - Home-tab entries carry a
//                     task_id instead of channel/message_ts
//   - "park"          (📌 "Park for 1:1" on a brief recommendation OR a
//                     Home-tab triage row): shaped { id: "park-<ms>", type,
//                     text, link, clickedAt, status, channel, message_ts } -
//                     Home-tab entries carry a task_id instead of
//                     channel/message_ts
//   - "archive_email" (🗑️ Archive on an actionable section item): shaped
//                     { id: <item id or "archive-<ms>">, type,
//                     gmail_thread_id, text, link, clickedAt, status,
//                     channel, message_ts }
//   - "urgent_done"   (✅ Done on an actionable section item): shaped like
//                     "archive_email" minus gmail_thread_id
//   - "snooze"        (⏰ Snooze on an actionable section item OR a brief
//                     recommendation): shaped { id: <item id or
//                     "snooze-<ms>">, type, text, link, due (the item's own
//                     due date when the payload set one, else null),
//                     clickedAt, status, channel, message_ts }
//   - "dismiss"       (✖️ Not for me on an actionable section item OR a
//                     brief recommendation): shaped like "snooze" minus due
//   (📝 "View draft" clicks queue NOTHING - they open a display-only modal)
//   - "refresh"       (🔄 Refresh brief button, on briefs and the Home tab):
//                     shaped { id: "refresh-<ms>", type, requested_at,
//                     channel, message_ts, status } - `id` is
//                     "refresh-" + Date.now() and `requested_at` is the ISO
//                     click time (instead of the crypto-UUID `id` +
//                     `clickedAt` other types use); channel/message_ts are
//                     null for Home-tab clicks (Home block_actions carry no
//                     message). An external sweep drains these and re-renders
//                     the brief.
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || os.tmpdir();
const DELEGATIONS_FILE = path.join(DATA_DIR, "delegations.json");

const delegations = [];
try {
  if (fs.existsSync(DELEGATIONS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DELEGATIONS_FILE, "utf8"));
    if (Array.isArray(loaded)) {
      delegations.push(...loaded);
      console.log(`Loaded ${loaded.length} delegation entries from ${DELEGATIONS_FILE}`);
    }
  }
} catch (err) {
  console.error(`Failed to load delegation queue from ${DELEGATIONS_FILE}:`, err);
}

/**
 * Persists the delegation queue to DELEGATIONS_FILE (write-to-temp +
 * rename, so a crash mid-write never truncates the previous good file).
 * Best-effort: persistence failures are logged, never thrown - the in-memory
 * queue keeps working exactly as before.
 */
function saveDelegations() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${DELEGATIONS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(delegations));
    fs.renameSync(tmpFile, DELEGATIONS_FILE);
  } catch (err) {
    console.error(`Failed to persist delegation queue to ${DELEGATIONS_FILE}:`, err);
  }
}

// Workspace host used to build permalinks for "Add to Triage" shortcut
// entries (categorization happens agent-side; the agent follows this link).
const SLACK_WORKSPACE_HOST = "rivian-vw-tech.slack.com";

const TRIAGE_ADD_TEXT_MAX = 300;

/** Builds a Slack message permalink: /archives/<channel>/p<ts without dot>. */
function buildPermalink(channelId, messageTs) {
  if (!channelId || !messageTs) return null;
  return `https://${SLACK_WORKSPACE_HOST}/archives/${channelId}/p${String(messageTs).replace(".", "")}`;
}

/**
 * Shared-secret guard used by /render-brief and the /delegations endpoints:
 * the X-Internal-Secret header must match INTERNAL_API_SECRET (401
 * otherwise, including when the env var is unset).
 */
function requireInternalSecret(req, res, next) {
  const providedSecret = req.get("X-Internal-Secret");
  if (!INTERNAL_API_SECRET || providedSecret !== INTERNAL_API_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /healthz - trivial health check. Also used as a keep-warm ping target
// (see README) so /slack/interactions stays responsive on free-tier hosting.
// Reports the running build's short git SHA so deploys can be verified from
// the outside. Computed ONCE at startup: Render exposes the deployed commit
// as RENDER_GIT_COMMIT; local checkouts fall back to `git rev-parse`.
// ---------------------------------------------------------------------------
const BUILD_VERSION = (() => {
  if (typeof process.env.RENDER_GIT_COMMIT === "string" && process.env.RENDER_GIT_COMMIT) {
    return process.env.RENDER_GIT_COMMIT.slice(0, 7);
  }
  try {
    const sha = require("child_process")
      .execSync("git rev-parse --short HEAD", {
        cwd: __dirname,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    return sha || "unknown";
  } catch (err) {
    return "unknown";
  }
})();

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", version: BUILD_VERSION });
});

// ---------------------------------------------------------------------------
// POST /render-brief
//
// Main entrypoint an external caller (e.g. a scheduled routine) uses to post
// a brand new Morning Brief message into a Slack channel/thread.
// Protected by a shared secret header, X-Internal-Secret. Body parsing is
// scoped to this route so it never interferes with /slack/interactions'
// form-encoded parsing below; the limit is raised past express.json's 100kb
// default because briefs keep growing.
// ---------------------------------------------------------------------------
const RENDER_BODY_LIMIT = "1mb";

app.post("/render-brief", requireInternalSecret, express.json({ limit: RENDER_BODY_LIMIT }), async (req, res) => {
  const { channel, thread_ts, priority_recap, sections, recommendations, title, emoji } =
    req.body || {};

  if (!channel) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message:
        "Expected { channel, thread_ts?, priority_recap?, sections?, recommendations?, title?, emoji? }",
    });
  }

  const blocks = buildBriefBlocks({ priority_recap, sections, recommendations, title, emoji });

  // Notification fallback text mirrors the rendered header (which carries
  // the custom title/emoji and the date stamp) - the header is always the
  // first block.
  const fallbackText =
    blocks[0] && blocks[0].type === "header" ? blocks[0].text.text : "Chief of Staff briefing";

  try {
    const slackResponse = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        thread_ts,
        text: fallbackText,
        blocks,
      }),
    });

    const slackJson = await slackResponse.json();

    if (slackJson.ok) {
      return res.json({ ok: true, ts: slackJson.ts });
    }

    return res.json({ ok: false, error: slackJson.error });
  } catch (err) {
    console.error("Error posting brief to Slack:", err);
    return res.status(502).json({ ok: false, error: "slack_request_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /update-home
//
// Publishes the App Home "bandwidth meter" view for a user via Slack's
// views.publish. Body: { user, date_label?, meeting_hours_today?,
// focus_hours_today?, meetings_this_week?, meeting_hours_week?,
// pending_items?, new_today?, on_call?, notes?, burndown?, projects?,
// tasks?, delegated? } - all
// fields except `user` are optional and only present fields are rendered
// (see src/home.js / README for the burndown + triage-task shapes). Protected by the same
// X-Internal-Secret header as /render-brief. NOTE: the Slack app's
// App Home -> Home Tab toggle must be ON, or views.publish fails (Slack
// returns an error like "not_enabled_for_app_home") - we relay Slack's
// response verbatim rather than faking success.
// ---------------------------------------------------------------------------
app.post("/update-home", requireInternalSecret, express.json({ limit: RENDER_BODY_LIMIT }), async (req, res) => {
  const body = req.body || {};

  if (!body.user || typeof body.user !== "string") {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Expected { user, date_label?, meeting_hours_today?, focus_hours_today?, ... }",
    });
  }

  const view = buildHomeView(body);

  try {
    const slackResponse = await fetch(`${SLACK_API_BASE}/views.publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        user_id: body.user,
        view,
      }),
    });

    const slackJson = await slackResponse.json();

    if (slackJson.ok) {
      return res.json({ ok: true });
    }

    return res.json({ ok: false, error: slackJson.error });
  } catch (err) {
    console.error("Error publishing App Home view to Slack:", err);
    return res.status(502).json({ ok: false, error: "slack_request_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /slack/interactions
//
// Receives Slack's block_actions interactivity payload (form-encoded, with
// the actual JSON payload in the `payload` field). We need the RAW body to
// verify Slack's request signature, so we capture it via a `verify` callback
// on express.urlencoded() before it gets parsed. This body parser is scoped
// to this route only - it never touches /render-brief's JSON parsing.
//
// Body-size limit: express.urlencoded defaults to 100kb, and Slack's
// block_actions payload embeds the FULL original message blocks (plus the
// {items,...} JSON in every button value) - a large brief pushes the payload
// past 100kb, making the parser reject the request with HTTP 413 before the
// handler ever runs. Slack then shows "This app responded with Status Code
// 413" on EVERY interactive element of that message. The limit is raised to
// 2mb; the `verify` raw-body capture runs inside this same parser, so it
// inherits the same limit and signature verification is unaffected.
//
// ACK-FIRST: the handler responds 200 immediately after signature
// verification + payload parse, then performs ALL processing (queue writes,
// Slack API calls, response_url POSTs) asynchronously in
// processInteraction() via setImmediate. This keeps us inside Slack's
// 3-second interactivity deadline ("Operation timed out") regardless of how
// long the follow-up work takes. processInteraction NEVER touches the
// response object - failures are logged, not returned.
// ---------------------------------------------------------------------------
const INTERACTIONS_BODY_LIMIT = "2mb";

const captureRawBody = (req, res, buf) => {
  req.rawBody = buf;
};

/**
 * Merges the rebuilt recommendations blocks into the original message's
 * blocks: everything ABOVE the recommendations header (found by its stable
 * `recs_header` block_id) is preserved, and everything from the header down
 * is replaced with the rebuilt list. Falls back to matching the header by
 * its "*Reply-worthy*" text (for messages posted before block_ids existed),
 * and finally to just the rebuilt recommendations blocks when the original
 * blocks are unavailable.
 *
 * @param {Array<object>|undefined} originalBlocks - payload.message.blocks
 * @param {Array<object>} newRecsBlocks
 * @returns {Array<object>}
 */
function mergeUpdatedBlocks(originalBlocks, newRecsBlocks) {
  if (!Array.isArray(originalBlocks) || originalBlocks.length === 0) {
    return newRecsBlocks;
  }

  let headerIndex = originalBlocks.findIndex((b) => b && b.block_id === RECS_HEADER_BLOCK_ID);
  if (headerIndex === -1) {
    headerIndex = originalBlocks.findIndex(
      (b) => b && b.type === "section" && b.text && b.text.text === `*${RECOMMENDATIONS_TITLE}*`
    );
  }
  if (headerIndex === -1) {
    return newRecsBlocks;
  }

  return [...originalBlocks.slice(0, headerIndex), ...newRecsBlocks];
}

/** Stable block_id prefix of each recommendation's buttons row (see blocks.js). */
const REC_ACTIONS_BLOCK_ID_PREFIX = "rec_actions_";

/**
 * Recovers each recommendation's link from the original message's blocks.
 * Button `value` payloads only carry links while the whole value fits under
 * ~1900 chars (long URLs would blow Slack's 2000-char button-value cap), so
 * on every interaction we also read them back from the message itself: the
 * `rec_actions_<id>` rows' 🔗 Open button URLs (current renders) and the
 * `rec_text_<id>` section blocks' accessory URLs (done/delegated rows, and
 * messages rendered before the 🔗 Open button existed).
 *
 * @param {Array<object>|undefined} originalBlocks - payload.message.blocks
 * @returns {Object<string, string>} map of recommendation id -> URL
 */
function extractRecLinks(originalBlocks) {
  const linkById = {};
  (originalBlocks || []).forEach((block) => {
    if (!block || typeof block.block_id !== "string") return;
    if (
      block.block_id.startsWith(REC_TEXT_BLOCK_ID_PREFIX) &&
      block.accessory &&
      typeof block.accessory.url === "string"
    ) {
      linkById[block.block_id.slice(REC_TEXT_BLOCK_ID_PREFIX.length)] = block.accessory.url;
    }
    if (block.block_id.startsWith(REC_ACTIONS_BLOCK_ID_PREFIX) && Array.isArray(block.elements)) {
      const openButton = block.elements.find(
        (el) =>
          el &&
          el.type === "button" &&
          typeof el.action_id === "string" &&
          el.action_id.startsWith("item_open") &&
          typeof el.url === "string"
      );
      if (openButton) {
        linkById[block.block_id.slice(REC_ACTIONS_BLOCK_ID_PREFIX.length)] = openButton.url;
      }
    }
  });
  return linkById;
}

/**
 * Recovers a recommendation's { itemId, text, link } from the original
 * message blocks, given the clicked element's actions-block block_id
 * (`rec_actions_<id>`). Used by the 📌 Park and 🙋 Delegate-to-person
 * elements, whose own values do NOT carry the {items, actedId} payload:
 * the text comes from a sibling 🔼/🔽/✅/🤖 button's value JSON, falling
 * back to the item's `rec_text_<id>` section text minus its "*N.* " rank
 * prefix; the link comes from that section's accessory URL (links never
 * travel in button values - see extractRecLinks). Returns null when the
 * click didn't come from a rec_actions_<id> block.
 *
 * @param {Array<object>|undefined} originalBlocks - payload.message.blocks
 * @param {string|undefined} actionsBlockId - the clicked element's block_id
 * @returns {{itemId: string, text: string, link: string|null}|null}
 */
function recoverRecItem(originalBlocks, actionsBlockId) {
  if (
    typeof actionsBlockId !== "string" ||
    !actionsBlockId.startsWith(REC_ACTIONS_BLOCK_ID_PREFIX)
  ) {
    return null;
  }
  const itemId = actionsBlockId.slice(REC_ACTIONS_BLOCK_ID_PREFIX.length);
  const blocks = Array.isArray(originalBlocks) ? originalBlocks : [];

  let text = "";
  const actionsBlock = blocks.find((b) => b && b.block_id === actionsBlockId);
  if (actionsBlock && Array.isArray(actionsBlock.elements)) {
    for (const el of actionsBlock.elements) {
      if (!el || el.type !== "button" || typeof el.value !== "string") continue;
      try {
        const decoded = JSON.parse(el.value);
        const item = Array.isArray(decoded && decoded.items)
          ? decoded.items.find((i) => i && i.id === itemId)
          : null;
        if (item && typeof item.text === "string" && item.text) {
          text = item.text;
          break;
        }
      } catch (err) {
        // Not an {items} payload (e.g. the 📌 button's static value) - keep looking.
      }
    }
  }
  if (!text) {
    const sectionBlock = blocks.find(
      (b) => b && b.block_id === `${REC_TEXT_BLOCK_ID_PREFIX}${itemId}`
    );
    if (sectionBlock && sectionBlock.text && typeof sectionBlock.text.text === "string") {
      text = sectionBlock.text.text.replace(/^\*\d+\.\*\s*/, "");
    }
  }

  return { itemId, text, link: extractRecLinks(blocks)[itemId] || null };
}

/**
 * Maps between the two block_ids of an actionable section item's pair:
 * `sec_item_<id>` (the section, holding the 🗑️/✅ accessory) and
 * `sec_item_actions_<id>` (the ⏰/✖️ row beneath it) - given either one,
 * returns the OTHER, or null when the id isn't part of such a pair. The
 * actions prefix is checked FIRST since it starts with the section prefix.
 *
 * @param {string|undefined} blockId
 * @returns {string|null}
 */
function secItemCompanionBlockId(blockId) {
  if (typeof blockId !== "string") return null;
  if (blockId.startsWith(SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX)) {
    return `${SEC_ITEM_BLOCK_ID_PREFIX}${blockId.slice(SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX.length)}`;
  }
  if (blockId.startsWith(SEC_ITEM_BLOCK_ID_PREFIX)) {
    return `${SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX}${blockId.slice(SEC_ITEM_BLOCK_ID_PREFIX.length)}`;
  }
  return null;
}

/** Stable block_id prefixes of each Home triage row's pair (see home.js). */
const HOME_TASK_BLOCK_ID_PREFIX = "task_";
const HOME_TASK_ACTIONS_BLOCK_ID_PREFIX = "task_actions_";

/**
 * Recovers a Home triage task's { taskId, text, link } from the Home view's
 * blocks, given the clicked element's actions-block block_id
 * (`task_actions_<id>`). Used by the 🙋 Delegate users_select, which carries
 * no value: text/link come from a sibling button's value JSON (✅/🤖/📌
 * values all carry {text, link?}, preferring one that still has the link),
 * falling back to the `task_<id>` section text with its "<url|text>"
 * hyperlink unwrapped. Returns null when the click didn't come from a
 * task_actions_<id> block.
 *
 * @param {Array<object>|undefined} viewBlocks - payload.view.blocks
 * @param {string|undefined} actionsBlockId - the clicked element's block_id
 * @returns {{taskId: string, text: string, link: string|null}|null}
 */
function recoverHomeTask(viewBlocks, actionsBlockId) {
  if (
    typeof actionsBlockId !== "string" ||
    !actionsBlockId.startsWith(HOME_TASK_ACTIONS_BLOCK_ID_PREFIX)
  ) {
    return null;
  }
  const taskId = actionsBlockId.slice(HOME_TASK_ACTIONS_BLOCK_ID_PREFIX.length);
  const blocks = Array.isArray(viewBlocks) ? viewBlocks : [];

  let text = "";
  let link = null;
  const actionsBlock = blocks.find((b) => b && b.block_id === actionsBlockId);
  if (actionsBlock && Array.isArray(actionsBlock.elements)) {
    for (const el of actionsBlock.elements) {
      if (!el || el.type !== "button" || typeof el.value !== "string") continue;
      try {
        const decoded = JSON.parse(el.value);
        if (decoded && typeof decoded.text === "string" && decoded.text) {
          if (!text) text = decoded.text;
          if (typeof decoded.link === "string" && decoded.link) {
            link = decoded.link;
            break; // text + link recovered - done
          }
        }
      } catch (err) {
        // Not a JSON value - keep looking.
      }
    }
  }
  if (!text) {
    const sectionBlock = blocks.find(
      (b) => b && b.block_id === `${HOME_TASK_BLOCK_ID_PREFIX}${taskId}`
    );
    if (sectionBlock && sectionBlock.text && typeof sectionBlock.text.text === "string") {
      // "<icon>[ 🔄] <url|text>" or "<icon>[ 🔄] text" - unwrap the hyperlink.
      const raw = sectionBlock.text.text;
      const match = raw.match(/<([^|>]+)\|([^>]*)>/);
      if (match) {
        if (!link) link = match[1];
        text = match[2];
      } else {
        text = raw.replace(/^\S+\s*/, "");
      }
    }
  }

  return { taskId, text, link };
}

/**
 * POSTs a replace_original message update to a block_actions response_url.
 * Failures are logged with `context` (the acting action_id), never thrown -
 * by the time this runs the interaction has long been acked.
 *
 * @param {string} responseUrl
 * @param {Array<object>} blocks
 * @param {string} context
 */
async function postResponseUrlUpdate(responseUrl, blocks, context) {
  try {
    const updateResponse = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: "Chief of Staff briefing",
        blocks,
      }),
    });
    if (!updateResponse.ok) {
      console.error(
        `response_url update after ${context} failed: HTTP ${updateResponse.status} ${await updateResponse
          .text()
          .catch(() => "")}`
      );
    }
  } catch (err) {
    console.error(`Error POSTing ${context} update to response_url:`, err);
  }
}

/**
 * Best-effort views.publish of a rewritten Home view (Home-tab clicks have
 * no response_url). Failures are logged with `context` (the acting
 * action_id), never thrown - the interaction was already acked and the next
 * scheduled /update-home push is the authoritative refresh anyway.
 *
 * @param {string} userId
 * @param {Array<object>} blocks
 * @param {string} context
 */
async function republishHomeView(userId, blocks, context) {
  try {
    const publishResponse = await fetch(`${SLACK_API_BASE}/views.publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        user_id: userId,
        view: { type: "home", blocks },
      }),
    });
    const publishJson = await publishResponse.json().catch(() => ({}));
    if (!publishJson.ok) {
      console.error(`Best-effort Home re-publish after ${context} failed: ${publishJson.error}`);
    }
  } catch (err) {
    console.error(`Error re-publishing Home view after ${context}:`, err);
  }
}

app.post(
  "/slack/interactions",
  express.urlencoded({ extended: false, limit: INTERACTIONS_BODY_LIMIT, verify: captureRawBody }),
  (req, res) => {
    const timestamp = req.get("X-Slack-Request-Timestamp");
    const signature = req.get("X-Slack-Signature");

    const isValid = verifySlackSignature({
      signingSecret: SLACK_SIGNING_SECRET,
      timestamp,
      signature,
      rawBody: req.rawBody,
    });

    if (!isValid) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.payload);
    } catch (err) {
      return res.status(400).json({ ok: false, error: "bad_payload" });
    }

    // ACK FIRST: everything past this point runs after the response - no
    // code below may touch `res`.
    res.status(200).end();

    setImmediate(() => {
      processInteraction(payload).catch((err) => {
        console.error("Error processing Slack interaction:", err);
      });
    });
  }
);

/**
 * Does all the actual interaction work AFTER the 200 ack (see the route
 * above). Must never touch the HTTP response - malformed payloads and
 * downstream failures are logged and swallowed.
 *
 * @param {object} payload - the parsed Slack interactivity payload
 */
async function processInteraction(payload) {
  // --- Message shortcut: "Add to Triage" ---------------------------------
  // A message shortcut payload (type "message_action") has no `actions`
  // array and no message to update - just queue a "triage_add" entry.
  // Categorization happens agent-side when the queue is drained.
  if (payload && payload.type === "message_action") {
    if (payload.callback_id !== "add_to_triage") {
      return; // unknown shortcut - already acked; ignore
    }

    const channelId = payload.channel && payload.channel.id;
    const messageTs = payload.message && payload.message.ts;
    const rawText = (payload.message && payload.message.text) || "";
    const text =
      rawText.length > TRIAGE_ADD_TEXT_MAX
        ? `${rawText.slice(0, TRIAGE_ADD_TEXT_MAX - 1)}…`
        : rawText;

    delegations.push({
      id: crypto.randomUUID(),
      type: "triage_add",
      text,
      channel: channelId || null,
      message_ts: messageTs || null,
      permalink: buildPermalink(channelId, messageTs),
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    return;
  }

  const action = payload && payload.actions && payload.actions[0];
  if (!action) {
    console.error("Interaction payload carried no actions - nothing to do");
    return;
  }

  // --- Home-tab triage: "✅ Complete" -------------------------------------
  // Home-tab block_actions arrive WITHOUT a response_url. Queue a
  // "task_complete" entry, then (best-effort) re-publish the Home view
  // minus the completed row via views.publish for instant feedback - the
  // hourly drain re-publishes the authoritative view later anyway.
  if (action.action_id === "task_complete") {
    let task;
    try {
      task = JSON.parse(action.value);
    } catch (err) {
      console.error("task_complete click carried an unparseable value - ignoring");
      return;
    }

    delegations.push({
      id: crypto.randomUUID(),
      type: "task_complete",
      taskId: task.taskId !== undefined ? task.taskId : null,
      text: task.text || "",
      source: task.source || "manual",
      link: task.link || null,
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    const view = payload.view;
    const userId = payload.user && payload.user.id;
    if (
      view &&
      view.type === "home" &&
      Array.isArray(view.blocks) &&
      userId &&
      task.taskId !== undefined
    ) {
      // Each triage row is a section (`task_<id>`) + actions
      // (`task_actions_<id>`) pair - drop both.
      const remaining = view.blocks.filter(
        (block) =>
          !(
            block &&
            (block.block_id === `task_${task.taskId}` ||
              block.block_id === `task_actions_${task.taskId}`)
          )
      );
      if (remaining.length < view.blocks.length) {
        try {
          const publishResponse = await fetch(`${SLACK_API_BASE}/views.publish`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            },
            body: JSON.stringify({
              user_id: userId,
              view: { type: "home", blocks: remaining },
            }),
          });
          const publishJson = await publishResponse.json().catch(() => ({}));
          if (!publishJson.ok) {
            console.error(
              `Best-effort Home re-publish after task_complete failed: ${publishJson.error}`
            );
          }
        } catch (err) {
          console.error("Error re-publishing Home view after task_complete:", err);
        }
      }
    }

    return;
  }

  // --- Home-tab triage: "🤖 Do it" -----------------------------------------
  // Queue a "bot_do" entry for the agent-side drain, then (best-effort)
  // re-publish the Home view with the row's text marked "→ 🤖 queued" and
  // its buttons row removed, so the same task can't be double-queued.
  if (action.action_id === "home_task_bot") {
    let task;
    try {
      task = JSON.parse(action.value);
    } catch (err) {
      console.error("home_task_bot click carried an unparseable value - ignoring");
      return;
    }

    delegations.push({
      id: `botdo-${Date.now()}`,
      type: "bot_do",
      task_id: task.id !== undefined ? task.id : null,
      text: task.text || "",
      link: task.link || null,
      source: task.source || "manual",
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    const view = payload.view;
    const userId = payload.user && payload.user.id;
    if (
      view &&
      view.type === "home" &&
      Array.isArray(view.blocks) &&
      userId &&
      task.id !== undefined &&
      task.id !== null
    ) {
      let changed = false;
      const newBlocks = view.blocks
        .filter((block) => !(block && block.block_id === `task_actions_${task.id}`))
        .map((block) => {
          if (
            !block ||
            block.block_id !== `task_${task.id}` ||
            !block.text ||
            typeof block.text.text !== "string"
          ) {
            return block;
          }
          changed = true;
          let newText = `${block.text.text} → 🤖 queued`;
          if (newText.length > MAX_SECTION_TEXT) {
            newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
          }
          return { ...block, text: { ...block.text, text: newText } };
        });
      if (changed || newBlocks.length < view.blocks.length) {
        await republishHomeView(userId, newBlocks, "home_task_bot");
      }
    }

    return;
  }

  // --- Home-tab triage: "📌 Park for 1:1" -----------------------------------
  // Queue a "park" entry (same type as the brief-side 📌, so the hourly
  // sweep handles both identically), then (best-effort) re-publish the Home
  // view with the row's text marked "→ 📌 queued" and its buttons row
  // removed, so the same task can't be double-parked.
  if (action.action_id === "home_task_park") {
    let task;
    try {
      task = JSON.parse(action.value);
    } catch (err) {
      console.error("home_task_park click carried an unparseable value - ignoring");
      return;
    }

    delegations.push({
      id: `park-${Date.now()}`,
      type: "park",
      task_id: task.id !== undefined ? task.id : null,
      text: task.text || "",
      link: task.link || null,
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    const view = payload.view;
    const userId = payload.user && payload.user.id;
    if (
      view &&
      view.type === "home" &&
      Array.isArray(view.blocks) &&
      userId &&
      task.id !== undefined &&
      task.id !== null
    ) {
      let changed = false;
      const newBlocks = view.blocks
        .filter((block) => !(block && block.block_id === `task_actions_${task.id}`))
        .map((block) => {
          if (
            !block ||
            block.block_id !== `task_${task.id}` ||
            !block.text ||
            typeof block.text.text !== "string"
          ) {
            return block;
          }
          changed = true;
          let newText = `${block.text.text} → 📌 queued`;
          if (newText.length > MAX_SECTION_TEXT) {
            newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
          }
          return { ...block, text: { ...block.text, text: newText } };
        });
      if (changed || newBlocks.length < view.blocks.length) {
        await republishHomeView(userId, newBlocks, "home_task_park");
      }
    }

    return;
  }

  // --- Home-tab triage: "🙋 Delegate to..." person picker --------------------
  // Selecting a person queues a "delegated_to" entry (same type as the
  // brief-side picker). The select carries no value: the task is recovered
  // from the block_id + sibling buttons' values (see recoverHomeTask). Then
  // (best-effort) re-publish the Home view with the row's text marked
  // "→ 🙋 delegated to <@USER>" and the 📌/🙋/🤖 elements removed - ✅ is
  // KEPT so the task can still be completed.
  if (action.action_id === "home_task_delegate") {
    const selectedUser = action.selected_user;
    if (!selectedUser) {
      console.error("home_task_delegate interaction carried no selected_user - ignoring");
      return;
    }

    const view = payload.view;
    const task = recoverHomeTask(view && view.blocks, action.block_id);
    if (!task) {
      console.error(
        `home_task_delegate click outside a ${HOME_TASK_ACTIONS_BLOCK_ID_PREFIX}<id> block - ignoring`
      );
      return;
    }

    delegations.push({
      id: `delegated-${Date.now()}`,
      type: "delegated_to",
      task_id: task.taskId,
      text: task.text,
      link: task.link,
      to_user_id: selectedUser,
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    const userId = payload.user && payload.user.id;
    if (view && view.type === "home" && Array.isArray(view.blocks) && userId) {
      let changed = false;
      const newBlocks = view.blocks.map((block) => {
        if (!block) return block;
        if (block.block_id === action.block_id && Array.isArray(block.elements)) {
          changed = true;
          return {
            ...block,
            // ✅ stays so the task can still be completed; the 🔗 Open link
            // button (item_open__<id>), when present, stays too.
            elements: block.elements.filter(
              (el) =>
                el &&
                (el.action_id === "task_complete" ||
                  (typeof el.action_id === "string" && el.action_id.startsWith("item_open")))
            ),
          };
        }
        if (
          block.block_id === `${HOME_TASK_BLOCK_ID_PREFIX}${task.taskId}` &&
          block.text &&
          typeof block.text.text === "string"
        ) {
          changed = true;
          let newText = `${block.text.text} → 🙋 delegated to <@${selectedUser}>`;
          if (newText.length > MAX_SECTION_TEXT) {
            newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
          }
          return { ...block, text: { ...block.text, text: newText } };
        }
        return block;
      });
      if (changed) {
        await republishHomeView(userId, newBlocks, "home_task_delegate");
      }
    }

    return;
  }

  // --- Home-tab 🎯 Projects: "🧹 Start sweep" -------------------------------
  // Gmail → Zero / Slack → Zero mission kick-off. Queue the matching
  // "gmail_zero_start" / "slack_zero_start" entry, then (best-effort)
  // re-publish the Home view with the clicked row's button removed and
  // "→ 🧹 sweep queued" appended, so the mission can't be double-queued.
  if (action.action_id === "project_gmail_zero" || action.action_id === "project_slack_zero") {
    const isGmail = action.action_id === "project_gmail_zero";
    delegations.push({
      id: `${isGmail ? "gmailzero" : "slackzero"}-${Date.now()}`,
      type: isGmail ? "gmail_zero_start" : "slack_zero_start",
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();

    const view = payload.view;
    const userId = payload.user && payload.user.id;
    if (view && view.type === "home" && Array.isArray(view.blocks) && userId) {
      let changed = false;
      const newBlocks = view.blocks.map((block) => {
        if (
          !block ||
          block.block_id !== action.block_id ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        changed = true;
        const { accessory, ...rest } = block; // drop the clicked button
        return { ...rest, text: { ...rest.text, text: `${rest.text.text} → 🧹 sweep queued` } };
      });
      if (changed) {
        await republishHomeView(userId, newBlocks, action.action_id);
      }
    }

    return;
  }

  // --- Brief refresh: "🔄 Refresh brief" ----------------------------------
  // Lives in the `voice_actions` row on briefs AND on the Home tab. Queue a
  // "refresh" delegation entry (persisted like every other type, so it
  // survives restarts and shows in GET /delegations/pending), then -
  // message clicks only - POST to response_url rewriting JUST the
  // voice_actions row: the refresh button's text becomes
  // "🔄 Queued — runs on the next sweep" and its action_id is swapped to
  // `brief_refresh_queued`, a no-op the unknown-action branch below
  // ignores, so the same message can't queue twice. The 🎙️ link button is
  // preserved untouched. Home-tab clicks have no response_url (and no
  // message), so they just enqueue. /delegations/complete only targets
  // `rec_text_<id>` section blocks, so it gracefully no-ops on the button
  // row for refresh entries (the entry is still marked).
  if (action.action_id === "brief_refresh") {
    const channelId = (payload.channel && payload.channel.id) || null;
    const messageTs = (payload.message && payload.message.ts) || null;

    delegations.push({
      id: `refresh-${Date.now()}`,
      type: "refresh",
      requested_at: new Date().toISOString(),
      channel: channelId,
      message_ts: messageTs,
      status: "pending",
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    const originalBlocks = payload.message && payload.message.blocks;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return; // Home-tab click (or no message context): enqueue only.
    }

    const newBlocks = originalBlocks.map((block) => {
      if (!block || block.block_id !== "voice_actions" || !Array.isArray(block.elements)) {
        return block;
      }
      return {
        ...block,
        elements: block.elements.map((el) =>
          el && el.action_id === "brief_refresh"
            ? {
                ...el,
                action_id: "brief_refresh_queued",
                text: {
                  type: "plain_text",
                  text: "🔄 Queued — runs on the next sweep",
                  emoji: true,
                },
              }
            : el
        ),
      };
    });

    await postResponseUrlUpdate(responseUrl, newBlocks, "brief_refresh");
    return;
  }

  // --- "🙋 Delegate to..." person picker -----------------------------------
  // A users_select on each recommendation row (action_id
  // `item_delegate_person`). It carries no value: the item's text/link are
  // recovered from the sibling buttons' values / the rec_text_<id> section
  // (see recoverRecItem). Queue a persisted "delegated_to" entry, then
  // rewrite the item's text in place to append
  // "→ 🙋 delegated to <@USER>" - the buttons row is KEPT so the item can
  // still be ✅-completed (or re-delegated) later.
  if (action.action_id === "item_delegate_person") {
    const selectedUser = action.selected_user;
    if (!selectedUser) {
      console.error("item_delegate_person interaction carried no selected_user - ignoring");
      return;
    }

    const originalBlocks = payload.message && payload.message.blocks;
    const item = recoverRecItem(originalBlocks, action.block_id);
    if (!item) {
      console.error(
        `item_delegate_person click outside a ${REC_ACTIONS_BLOCK_ID_PREFIX}<id> block - ignoring`
      );
      return;
    }

    delegations.push({
      id: `delegated-${Date.now()}`,
      type: "delegated_to",
      text: item.text,
      link: item.link,
      to_user_id: selectedUser,
      clickedAt: new Date().toISOString(),
      status: "pending",
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return;
    }

    const targetBlockId = `${REC_TEXT_BLOCK_ID_PREFIX}${item.itemId}`;
    const newBlocks = originalBlocks.map((block) => {
      if (
        !block ||
        block.block_id !== targetBlockId ||
        !block.text ||
        typeof block.text.text !== "string"
      ) {
        return block;
      }
      let newText = `${block.text.text}  → 🙋 delegated to <@${selectedUser}>`;
      if (newText.length > MAX_SECTION_TEXT) {
        newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
      }
      return { ...block, text: { ...block.text, text: newText } };
    });

    await postResponseUrlUpdate(responseUrl, newBlocks, "item_delegate_person");
    return;
  }

  // --- "📌 Park for 1:1" ----------------------------------------------------
  // Parks the item for the next 1:1: queue a persisted "park" entry (text/
  // link recovered exactly like the person picker above), then rewrite the
  // item's text to append "→ 📌 parked for next 1:1" and REMOVE its buttons
  // row (parked counts as handled - no further actions on it).
  if (action.action_id === "item_park") {
    const originalBlocks = payload.message && payload.message.blocks;
    const item = recoverRecItem(originalBlocks, action.block_id);
    if (!item) {
      console.error(
        `item_park click outside a ${REC_ACTIONS_BLOCK_ID_PREFIX}<id> block - ignoring`
      );
      return;
    }

    delegations.push({
      id: `park-${Date.now()}`,
      type: "park",
      text: item.text,
      link: item.link,
      clickedAt: new Date().toISOString(),
      status: "pending",
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return;
    }

    const targetBlockId = `${REC_TEXT_BLOCK_ID_PREFIX}${item.itemId}`;
    const newBlocks = originalBlocks
      .filter((block) => !(block && block.block_id === action.block_id))
      .map((block) => {
        if (
          !block ||
          block.block_id !== targetBlockId ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        let newText = `${block.text.text}  → 📌 parked for next 1:1`;
        if (newText.length > MAX_SECTION_TEXT) {
          newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
        }
        const parked = { ...block, text: { ...block.text, text: newText } };
        // The row's actions block (holding its 🔗 Open link button) was just
        // removed - re-attach the link as a section accessory so a parked
        // item keeps its Open affordance.
        if (!parked.accessory && item.link) {
          parked.accessory = {
            type: "button",
            text: { type: "plain_text", text: "Open", emoji: true },
            url: item.link,
          };
        }
        return parked;
      });

    await postResponseUrlUpdate(responseUrl, newBlocks, "item_park");
    return;
  }

  // --- "⏰ Snooze" / "✖️ Not for me" (recommendation rows) -------------------
  // Same recovery pattern as 📌 Park: the button values are static markers
  // ({"type":"snooze","due"?} / {"type":"dismiss"}), and the item's
  // text/link come from the sibling buttons' values / the rec_text_<id>
  // section (see recoverRecItem). Queue a persisted "snooze" / "dismiss"
  // entry, then rewrite the item in place - snoozed keeps its text with a
  // "→ ⏰ snoozed" suffix (Open link re-attached as an accessory, like
  // Park), dismissed is struck through with "→ ✖️ not for me" - and REMOVE
  // its buttons row (handled - no further actions on it).
  if (action.action_id === "item_snooze" || action.action_id === "item_dismiss") {
    const isSnooze = action.action_id === "item_snooze";
    const originalBlocks = payload.message && payload.message.blocks;
    const item = recoverRecItem(originalBlocks, action.block_id);
    if (!item) {
      console.error(
        `${action.action_id} click outside a ${REC_ACTIONS_BLOCK_ID_PREFIX}<id> block - ignoring`
      );
      return;
    }

    // The snooze marker value carries the item's `due` date when the
    // /render-brief payload set one.
    let due = null;
    try {
      const marker = JSON.parse(action.value);
      if (marker && typeof marker.due === "string" && marker.due) due = marker.due;
    } catch (err) {
      // Static marker missing/unparseable - the entry just has no due date.
    }

    delegations.push({
      id: `${isSnooze ? "snooze" : "dismiss"}-${Date.now()}`,
      type: isSnooze ? "snooze" : "dismiss",
      text: item.text,
      link: item.link,
      ...(isSnooze ? { due } : {}),
      clickedAt: new Date().toISOString(),
      status: "pending",
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return;
    }

    const targetBlockId = `${REC_TEXT_BLOCK_ID_PREFIX}${item.itemId}`;
    const newBlocks = originalBlocks
      .filter((block) => !(block && block.block_id === action.block_id))
      .map((block) => {
        if (
          !block ||
          block.block_id !== targetBlockId ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        let newText = isSnooze
          ? `${block.text.text}  → ⏰ snoozed`
          : `~${block.text.text}~  → ✖️ not for me`;
        if (newText.length > MAX_SECTION_TEXT) {
          newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
        }
        const marked = { ...block, text: { ...block.text, text: newText } };
        // The row's actions block (holding its 🔗 Open link button) was just
        // removed - re-attach the link as a section accessory so a snoozed
        // item keeps its Open affordance (a dismissed item doesn't need one).
        if (isSnooze && !marked.accessory && item.link) {
          marked.accessory = {
            type: "button",
            text: { type: "plain_text", text: "Open", emoji: true },
            url: item.link,
          };
        }
        return marked;
      });

    await postResponseUrlUpdate(responseUrl, newBlocks, action.action_id);
    return;
  }

  // --- Actionable section items: 🗑️ Archive / ✅ Done ----------------------
  // Section items rendered with an accessory button (see blocks.js). The
  // button value carries {id, type, gmail_thread_id?, text, link?}. Queue
  // the matching delegation entry ("archive_email" / "urgent_done"), then
  // rewrite JUST the clicked block via response_url: strikethrough text plus
  // a queued/done suffix, accessory button removed. Every other block is
  // passed through untouched.
  if (action.action_id === "sec_item_archive" || action.action_id === "sec_item_done") {
    let value;
    try {
      value = JSON.parse(action.value);
    } catch (err) {
      console.error(`${action.action_id} click carried an unparseable value - ignoring`);
      return;
    }

    const isArchive = action.action_id === "sec_item_archive";
    delegations.push({
      id: value.id || `${isArchive ? "archive" : "done"}-${Date.now()}`,
      type: isArchive ? "archive_email" : "urgent_done",
      ...(isArchive ? { gmail_thread_id: value.gmail_thread_id || null } : {}),
      text: value.text || "",
      link: value.link || null,
      clickedAt: new Date().toISOString(),
      status: "pending",
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    const originalBlocks = payload.message && payload.message.blocks;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return;
    }

    const suffix = isArchive ? " → 🗑️ queued (runs on the next sweep)" : " → ✅ done";
    // The item's companion ⏰/✖️ actions row (block_id `sec_item_actions_<id>`)
    // is removed along with the clicked accessory - the item is handled.
    const companionBlockId = secItemCompanionBlockId(action.block_id);
    const newBlocks = originalBlocks
      .filter((block) => !(block && companionBlockId && block.block_id === companionBlockId))
      .map((block) => {
        if (
          !block ||
          block.block_id !== action.block_id ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        const { accessory, ...rest } = block; // drop the clicked button
        let newText = `~${block.text.text}~${suffix}`;
        if (newText.length > MAX_SECTION_TEXT) {
          newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
        }
        return { ...rest, text: { ...rest.text, text: newText } };
      });

    await postResponseUrlUpdate(responseUrl, newBlocks, action.action_id);
    return;
  }

  // --- Actionable section items: ⏰ Snooze / ✖️ Not for me -------------------
  // Buttons in the `sec_item_actions_<id>` row under each actionable section
  // item (see blocks.js). The value carries {id, type, due?, text, link?}.
  // Queue the matching "snooze" / "dismiss" delegation entry, then rewrite
  // the item's `sec_item_<id>` section via response_url - snoozed items keep
  // their text with a "→ ⏰ snoozed" suffix, dismissed items are struck
  // through with "→ ✖️ not for me" - and remove both the section's accessory
  // button and the clicked actions row, so the item can't be double-queued.
  if (action.action_id === "sec_item_snooze" || action.action_id === "sec_item_dismiss") {
    let value;
    try {
      value = JSON.parse(action.value);
    } catch (err) {
      console.error(`${action.action_id} click carried an unparseable value - ignoring`);
      return;
    }

    const isSnooze = action.action_id === "sec_item_snooze";
    delegations.push({
      id: value.id || `${isSnooze ? "snooze" : "dismiss"}-${Date.now()}`,
      type: isSnooze ? "snooze" : "dismiss",
      text: value.text || "",
      link: value.link || null,
      ...(isSnooze ? { due: value.due || null } : {}),
      clickedAt: new Date().toISOString(),
      status: "pending",
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
    });
    saveDelegations();

    const responseUrl = payload.response_url;
    const originalBlocks = payload.message && payload.message.blocks;
    if (!responseUrl || !Array.isArray(originalBlocks) || originalBlocks.length === 0) {
      return;
    }

    // The click came from the actions row (`sec_item_actions_<id>`); the
    // item's text lives in its sibling section (`sec_item_<id>`).
    const sectionBlockId = secItemCompanionBlockId(action.block_id);
    const newBlocks = originalBlocks
      .filter((block) => !(block && block.block_id === action.block_id))
      .map((block) => {
        if (
          !block ||
          !sectionBlockId ||
          block.block_id !== sectionBlockId ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        const { accessory, ...rest } = block; // drop the 🗑️/✅ accessory too
        let newText = isSnooze
          ? `${block.text.text} → ⏰ snoozed`
          : `~${block.text.text}~ → ✖️ not for me`;
        if (newText.length > MAX_SECTION_TEXT) {
          newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
        }
        return { ...rest, text: { ...rest.text, text: newText } };
      });

    await postResponseUrlUpdate(responseUrl, newBlocks, action.action_id);
    return;
  }

  // --- "📝 View draft" ------------------------------------------------------
  // Accessory on draft-carrying section items (e.g. the Delegated section's
  // ready-to-send nudges) and in the ⏰/✖️ row of actionable items. Opens a
  // modal (views.open with the interaction's trigger_id) showing the draft
  // in a copyable code block. Display only: nothing is queued, nothing is
  // sent, and the message is left untouched. trigger_ids expire after 3
  // seconds, so this runs immediately after the ack; a failure is logged and
  // swallowed like every other post-ack Slack call.
  if (action.action_id === "sec_item_view_draft") {
    let value;
    try {
      value = JSON.parse(action.value);
    } catch (err) {
      console.error("sec_item_view_draft click carried an unparseable value - ignoring");
      return;
    }
    const draft = typeof value.draft === "string" ? value.draft : "";
    if (!draft || !payload.trigger_id) {
      console.error("sec_item_view_draft click had no draft/trigger_id - ignoring");
      return;
    }

    // Escape Slack mrkdwn control chars so the draft renders verbatim inside
    // the code block.
    const escaped = draft.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    try {
      const openResponse = await fetch(`${SLACK_API_BASE}/views.open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Draft", emoji: true },
            close: { type: "plain_text", text: "Close", emoji: true },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `\`\`\`${escaped.slice(0, MAX_SECTION_TEXT - 6)}\`\`\``,
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "Copy the text above - nothing is sent automatically.",
                  },
                ],
              },
            ],
          },
        }),
      });
      const openJson = await openResponse.json().catch(() => ({}));
      if (!openJson.ok) {
        console.error(`views.open for sec_item_view_draft failed: ${openJson.error}`);
      }
    } catch (err) {
      console.error("Error opening draft modal:", err);
    }
    return;
  }

  // --- Link buttons / unknown actions -------------------------------------
  // Link buttons (the 🔗 Open `item_open__<id>` buttons on brief and Home
  // rows, and the 🎙️ "Hear it" voice_open button) are handled entirely
  // client-side by Slack - the URL opens in the browser - but Slack STILL
  // sends a block_actions event for the click. It was already acked with an
  // empty 200 (as is any other unrecognized action_id, e.g. the post-queue
  // `brief_refresh_queued` no-op button), so there is nothing left to do:
  // no delegation entry is ever enqueued for them and clicks never surface
  // an error in Slack.
  const KNOWN_BRIEF_ACTIONS = new Set(["item_up", "item_down", "item_done", "item_delegate"]);
  if (!KNOWN_BRIEF_ACTIONS.has(action.action_id)) {
    return;
  }

  let decoded;
  try {
    decoded = JSON.parse(action.value);
  } catch (err) {
    console.error(`${action.action_id} click carried an unparseable value - ignoring`);
    return;
  }

  const { items, actedId } = decoded;
  if (!Array.isArray(items) || !actedId) {
    console.error(`${action.action_id} click value had no items/actedId - ignoring`);
    return;
  }

  const originalBlocks = payload.message && payload.message.blocks;

  // Re-attach links (not carried in button values) from the original blocks.
  const linkById = extractRecLinks(originalBlocks);
  items.forEach((item) => {
    if (item && !item.link && linkById[item.id]) {
      item.link = linkById[item.id];
    }
  });

  // "🤖 Do it": push the clicked item onto the delegation queue (link
  // recovered from the message's accessory URLs above), regardless of
  // whether the message update below succeeds. `channel`/`message_ts`
  // identify the original brief message so /delegations/complete can later
  // strike the item out in place.
  if (action.action_id === "item_delegate") {
    const acted = items.find((item) => item && item.id === actedId);
    delegations.push({
      id: crypto.randomUUID(),
      type: "calendar",
      itemId: actedId,
      text: acted && acted.text ? acted.text : "",
      link: (acted && acted.link) || null,
      channel: (payload.channel && payload.channel.id) || null,
      message_ts: (payload.message && payload.message.ts) || null,
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    saveDelegations();
  }

  const responseUrl = payload.response_url;
  if (!responseUrl) {
    console.error("block_actions payload had no response_url; cannot update message");
    return;
  }

  const newItems = applyAction(items, actedId, action.action_id);
  const newRecsBlocks = buildRecommendationsBlocks(newItems);
  const newBlocks = mergeUpdatedBlocks(originalBlocks, newRecsBlocks);

  await postResponseUrlUpdate(responseUrl, newBlocks, action.action_id);
}

// ---------------------------------------------------------------------------
// GET /delegations/pending
//
// Returns every delegation-queue entry still awaiting an ack:
// { items: [{ id, type, ..., clickedAt, status: "pending" }] } where `type`
// is "calendar" | "task_complete" | "bot_do" | "triage_add" |
// "archive_email" | "urgent_done" | "snooze" | "dismiss" | "refresh" |
// "gmail_zero_start" | "slack_zero_start" (see the queue comment at
// the top of this file for per-type fields). Entries queued before the
// `type` field existed are reported as "calendar" so consumers can always
// distinguish. Protected by the same X-Internal-Secret header as
// /render-brief.
// ---------------------------------------------------------------------------
app.get("/delegations/pending", requireInternalSecret, (req, res) => {
  res.json({
    items: delegations
      .filter((entry) => entry.status === "pending")
      .map((entry) => (entry.type ? entry : { ...entry, type: "calendar" })),
  });
});

// ---------------------------------------------------------------------------
// POST /delegations/ack
//
// Body: { ids: [...], status: "done"|"failed", note?: string }. Marks the
// matching queue entries with the given status (entries stay in memory -
// they simply leave the pending list). Responds { ok: true, updated: N }.
// Protected by the same X-Internal-Secret header as /render-brief.
// ---------------------------------------------------------------------------
app.post("/delegations/ack", requireInternalSecret, express.json(), (req, res) => {
  const { ids, status, note } = req.body || {};

  if (!Array.isArray(ids) || (status !== "done" && status !== "failed")) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: 'Expected { ids: [...], status: "done"|"failed", note?: string }',
    });
  }

  const idSet = new Set(ids);
  let updated = 0;
  delegations.forEach((entry) => {
    if (idSet.has(entry.id)) {
      entry.status = status;
      entry.ackedAt = new Date().toISOString();
      if (typeof note === "string" && note) {
        entry.note = note;
      }
      updated += 1;
    }
  });
  if (updated > 0) {
    saveDelegations();
  }

  res.json({ ok: true, updated });
});

// ---------------------------------------------------------------------------
// POST /delegations/complete
//
// Body: { id: "<delegation id>", status: "done"|"failed", note?: string }.
// Marks the single matching queue entry (same status semantics as
// /delegations/ack), then - when the entry carries a `channel`/`message_ts`
// reference to the original brief message (🤖 "calendar" entries do) -
// updates that message in place:
//   - status "done": the item's `rec_text_<itemId>` section text is struck
//     through with a "✔ done — <note>" suffix and its `rec_actions_<itemId>`
//     block (the one immediately following, when it belongs to that item) is
//     removed.
//   - status "failed": the text is prefixed with "⚠️" and the note appended
//     (no strikethrough, actions kept).
// The message is fetched via conversations.history (latest=ts, inclusive,
// limit 1) and rewritten via chat.update; Slack's real result is returned.
// If the original message can't be found/updated, the queue entry is STILL
// marked, and { ok: false, error } tells the caller why the visual update
// didn't happen. Protected by the same X-Internal-Secret header as
// /render-brief.
// ---------------------------------------------------------------------------
const MAX_SECTION_TEXT = 2990; // Slack section text cap is 3000 chars

app.post("/delegations/complete", requireInternalSecret, express.json(), async (req, res) => {
  const { id, status, note } = req.body || {};

  if (typeof id !== "string" || !id || (status !== "done" && status !== "failed")) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: 'Expected { id: "<delegation id>", status: "done"|"failed", note?: string }',
    });
  }

  const entry = delegations.find((e) => e.id === id);
  if (!entry) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }

  // Mark the queue entry first (same as /delegations/ack) - this must stick
  // even when the Slack message update below fails.
  entry.status = status;
  entry.ackedAt = new Date().toISOString();
  if (typeof note === "string" && note) {
    entry.note = note;
  }
  saveDelegations();

  if (!entry.channel || !entry.message_ts) {
    return res.json({ ok: false, error: "no_message_reference" });
  }

  try {
    // Fetch the original message's current blocks (chat.update requires the
    // FULL blocks array, so we read the live message rather than trusting
    // any stale copy).
    const historyParams = new URLSearchParams({
      channel: entry.channel,
      latest: entry.message_ts,
      inclusive: "true",
      limit: "1",
    });
    const historyResponse = await fetch(
      `${SLACK_API_BASE}/conversations.history?${historyParams}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const historyJson = await historyResponse.json();

    if (!historyJson.ok) {
      return res.json({ ok: false, error: historyJson.error || "history_failed" });
    }

    const message =
      Array.isArray(historyJson.messages) &&
      historyJson.messages.find((m) => m && m.ts === entry.message_ts);
    if (!message || !Array.isArray(message.blocks) || message.blocks.length === 0) {
      return res.json({ ok: false, error: "message_not_found" });
    }

    // Locate the item's section block: primary key is its stable
    // `rec_text_<itemId>` block_id; fallback is a text match on the entry's
    // stored text (for entries queued before itemId existed).
    const blocks = message.blocks;
    let targetIndex = -1;
    if (entry.itemId != null) {
      targetIndex = blocks.findIndex(
        (b) => b && b.block_id === `${REC_TEXT_BLOCK_ID_PREFIX}${entry.itemId}`
      );
    }
    if (targetIndex === -1 && entry.text) {
      targetIndex = blocks.findIndex(
        (b) =>
          b &&
          b.type === "section" &&
          b.text &&
          typeof b.text.text === "string" &&
          b.text.text.includes(entry.text)
      );
    }
    if (targetIndex === -1 || !blocks[targetIndex].text) {
      return res.json({ ok: false, error: "item_block_not_found" });
    }

    const target = blocks[targetIndex];
    const originalText = target.text.text;
    let newText =
      status === "done" ? `~${originalText}~  ✔ done` : `⚠️ ${originalText}`;
    if (typeof note === "string" && note) {
      newText += ` — ${note}`;
    }
    if (newText.length > MAX_SECTION_TEXT) {
      newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
    }

    const newBlocks = blocks.map((b, i) =>
      i === targetIndex ? { ...b, text: { ...b.text, text: newText } } : b
    );

    // On "done", also drop the item's actions block - the block immediately
    // following the section, but only when it verifiably belongs to this
    // item (block_id `rec_actions_<itemId>`). Usually already gone (the 🤖
    // click strips it), but a failed response_url update can leave it.
    if (status === "done") {
      let itemId = entry.itemId;
      if (
        itemId == null &&
        typeof target.block_id === "string" &&
        target.block_id.startsWith(REC_TEXT_BLOCK_ID_PREFIX)
      ) {
        itemId = target.block_id.slice(REC_TEXT_BLOCK_ID_PREFIX.length);
      }
      const next = newBlocks[targetIndex + 1];
      if (
        next &&
        next.type === "actions" &&
        itemId != null &&
        next.block_id === `rec_actions_${itemId}`
      ) {
        newBlocks.splice(targetIndex + 1, 1);
      }
    }

    const updateResponse = await fetch(`${SLACK_API_BASE}/chat.update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: entry.channel,
        ts: entry.message_ts,
        text: message.text || "Chief of Staff briefing",
        blocks: newBlocks,
      }),
    });
    const updateJson = await updateResponse.json();

    if (updateJson.ok) {
      return res.json({ ok: true, ts: updateJson.ts, channel: updateJson.channel });
    }
    return res.json({ ok: false, error: updateJson.error });
  } catch (err) {
    console.error("Error updating original message for /delegations/complete:", err);
    return res.status(502).json({ ok: false, error: "slack_request_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Chief of Staff bot listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Keep-warm self-ping. The external cron-job.org pinger (see README) only
// covers limited days/hours, so while THIS process is alive it also GETs its
// own public /healthz every 5 minutes - inbound traffic that stops Render's
// free-tier ~15-min inactivity spin-down. NOTE: a self-ping can only prevent
// sleep while the process is running; it cannot WAKE an instance that has
// already spun down (or was restarted by a platform incident), so the
// external pinger remains the wake-up path. Best-effort and silent: failures
// are swallowed, and the timer is unref'd so it never keeps a test process
// alive. Set KEEP_WARM=off to disable (e.g. for local runs).
const KEEP_WARM_URL = `${
  process.env.RENDER_EXTERNAL_URL || "https://gustavo-chief-of-staff-bot-1.onrender.com"
}/healthz`;
const KEEP_WARM_INTERVAL_MS = 5 * 60 * 1000;
if (process.env.KEEP_WARM !== "off") {
  const keepWarmTimer = setInterval(() => {
    try {
      fetch(KEEP_WARM_URL).catch(() => {});
    } catch (err) {
      // fetch unavailable or threw synchronously - never crash over a ping.
    }
  }, KEEP_WARM_INTERVAL_MS);
  if (typeof keepWarmTimer.unref === "function") keepWarmTimer.unref();
}

module.exports = app;
