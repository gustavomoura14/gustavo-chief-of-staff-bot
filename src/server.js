"use strict";

const express = require("express");
const {
  buildBriefBlocks,
  buildRecommendationsBlocks,
  applyAction,
  RECOMMENDATIONS_TITLE,
  RECS_HEADER_BLOCK_ID,
} = require("./blocks");
const { verifySlackSignature } = require("./verify");

const app = express();
const PORT = process.env.PORT || 3000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

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
app.post("/render-brief", express.json(), async (req, res) => {
  const providedSecret = req.get("X-Internal-Secret");
  if (!INTERNAL_API_SECRET || providedSecret !== INTERNAL_API_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { channel, thread_ts, priority_recap, sections, recommendations } = req.body || {};

  if (!channel) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Expected { channel, thread_ts?, priority_recap?, sections?, recommendations? }",
    });
  }

  const blocks = buildBriefBlocks({ priority_recap, sections, recommendations });

  try {
    const slackResponse = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        thread_ts,
        text: "☀️ Morning Brief",
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

    const action = payload && payload.actions && payload.actions[0];
    if (!action) {
      return res.status(400).json({ ok: false, error: "no_action" });
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

    const responseUrl = payload.response_url;
    if (!responseUrl) {
      console.error("block_actions payload had no response_url; cannot update message");
      return;
    }

    const newItems = applyAction(items, actedId, action.action_id);
    const newRecsBlocks = buildRecommendationsBlocks(newItems);
    const originalBlocks = payload.message && payload.message.blocks;
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

app.listen(PORT, () => {
  console.log(`Chief of Staff bot listening on port ${PORT}`);
});

module.exports = app;
