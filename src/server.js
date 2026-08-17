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
//   - "triage_add"    ("Add to Triage" message shortcut): + text, channel,
//                     message_ts, permalink
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
// ---------------------------------------------------------------------------
app.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// POST /render-brief
//
// Main entrypoint an external caller (e.g. a scheduled routine) uses to post
// a brand new Morning Brief message into a Slack channel/thread.
// Protected by a shared secret header, X-Internal-Secret. Body parsing is
// scoped to this route so it never interferes with /slack/interactions'
// form-encoded parsing below.
// ---------------------------------------------------------------------------
app.post("/render-brief", requireInternalSecret, express.json(), async (req, res) => {
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
// pending_items?, new_today?, on_call?, notes?, burndown?, tasks? } - all
// fields except `user` are optional and only present fields are rendered
// (see src/home.js / README for the burndown + triage-task shapes). Protected by the same
// X-Internal-Secret header as /render-brief. NOTE: the Slack app's
// App Home -> Home Tab toggle must be ON, or views.publish fails (Slack
// returns an error like "not_enabled_for_app_home") - we relay Slack's
// response verbatim rather than faking success.
// ---------------------------------------------------------------------------
app.post("/update-home", requireInternalSecret, express.json(), async (req, res) => {
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
// ---------------------------------------------------------------------------
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

/**
 * Recovers each recommendation's link from the original message's blocks.
 * Button `value` payloads deliberately do NOT carry links (long URLs would
 * blow Slack's 2000-char button-value cap), so on every interaction we read
 * them back from the `rec_text_<id>` section blocks' accessory URLs.
 *
 * @param {Array<object>|undefined} originalBlocks - payload.message.blocks
 * @returns {Object<string, string>} map of recommendation id -> URL
 */
function extractRecLinks(originalBlocks) {
  const linkById = {};
  (originalBlocks || []).forEach((block) => {
    if (
      block &&
      typeof block.block_id === "string" &&
      block.block_id.startsWith(REC_TEXT_BLOCK_ID_PREFIX) &&
      block.accessory &&
      typeof block.accessory.url === "string"
    ) {
      linkById[block.block_id.slice(REC_TEXT_BLOCK_ID_PREFIX.length)] = block.accessory.url;
    }
  });
  return linkById;
}

app.post(
  "/slack/interactions",
  express.urlencoded({ extended: false, verify: captureRawBody }),
  async (req, res) => {
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

    // --- Message shortcut: "Add to Triage" ---------------------------------
    // A message shortcut payload (type "message_action") has no `actions`
    // array and no message to update - just ack 200 and queue a "triage_add"
    // entry. Categorization happens agent-side when the queue is drained.
    if (payload && payload.type === "message_action") {
      if (payload.callback_id !== "add_to_triage") {
        return res.status(200).end(); // unknown shortcut - ack and ignore
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

      return res.status(200).end();
    }

    const action = payload && payload.actions && payload.actions[0];
    if (!action) {
      return res.status(400).json({ ok: false, error: "no_action" });
    }

    // --- Home-tab triage: "✅ Complete" -------------------------------------
    // Home-tab block_actions arrive WITHOUT a response_url. Ack 200, queue a
    // "task_complete" entry, then (best-effort) re-publish the Home view
    // minus the completed row via views.publish for instant feedback - the
    // hourly drain re-publishes the authoritative view later anyway.
    if (action.action_id === "task_complete") {
      let task;
      try {
        task = JSON.parse(action.value);
      } catch (err) {
        return res.status(400).json({ ok: false, error: "bad_action_value" });
      }

      res.status(200).end();

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
        const remaining = view.blocks.filter(
          (block) => !(block && block.block_id === `task_${task.taskId}`)
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

    let decoded;
    try {
      decoded = JSON.parse(action.value);
    } catch (err) {
      return res.status(400).json({ ok: false, error: "bad_action_value" });
    }

    const { items, actedId } = decoded;
    if (!Array.isArray(items) || !actedId) {
      return res.status(400).json({ ok: false, error: "bad_action_value" });
    }

    // Ack immediately with an empty 200. Slack IGNORES the ack body for
    // block_actions message updates - the update must instead be POSTed to
    // the payload's response_url. Acking first keeps us inside Slack's 3s
    // deadline regardless of how long that follow-up POST takes.
    res.status(200).end();

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

    try {
      const updateResponse = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: "Chief of Staff briefing",
          blocks: newBlocks,
        }),
      });
      if (!updateResponse.ok) {
        console.error(
          `response_url update failed: HTTP ${updateResponse.status} ${await updateResponse
            .text()
            .catch(() => "")}`
        );
      }
    } catch (err) {
      console.error("Error POSTing message update to response_url:", err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /delegations/pending
//
// Returns every delegation-queue entry still awaiting an ack:
// { items: [{ id, type, ..., clickedAt, status: "pending" }] } where `type`
// is "calendar" | "task_complete" | "triage_add" (see the queue comment at
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

module.exports = app;
