"use strict";

const express = require("express");
const { buildBriefBlocks, buildRecommendationsBlocks, applyAction } = require("./blocks");
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

app.post(
  "/slack/interactions",
  express.urlencoded({ extended: false, verify: captureRawBody }),
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

    const newItems = applyAction(items, actedId, action.action_id);
    const newBlocks = buildRecommendationsBlocks(newItems);

    // Responding here, within this same HTTP response, is how Slack lets us
    // update ("replace") the original message - no outbound Slack API call
    // needed.
    return res.status(200).json({
      replace_original: true,
      text: "Chief of Staff briefing",
      blocks: newBlocks,
    });
  }
);

app.listen(PORT, () => {
  console.log(`Chief of Staff bot listening on port ${PORT}`);
});

module.exports = app;
