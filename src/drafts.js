"use strict";

/**
 * Draft-only delivery. This module gets a reply INTO Gustavo's hands ready to
 * send — it NEVER sends anything as him. That is a core product rule, not an
 * implementation detail:
 *
 *   - EMAIL drafts: when the Gmail creds exist (same three env vars as the
 *     cleanup section), the draft is written into his real Gmail Drafts
 *     folder via users.drafts.create, and a "Open in Gmail Drafts" link is
 *     surfaced. There is no gmail.send anywhere in this codebase.
 *   - SLACK drafts: the bot posts the ready-to-paste text (as itself, to the
 *     CoS channel COS_CHANNEL — the same private channel his briefs land in)
 *     in a copyable code block, plus a deep link to the target conversation.
 *     Gustavo pastes and sends himself. There is no user-token chat:write
 *     anywhere in this codebase.
 *
 * Draft text either arrives verbatim in the request, or — when the optional
 * AI helper is configured (see src/ai.js) — is generated from the request's
 * `context`. Entry point: deliverDraft(), called by POST /drafts in
 * server.js. Gating summary: email needs the Gmail env vars; slack needs
 * COS_CHANNEL; generation needs the Anthropic env vars. Anything unset just
 * makes that path return a config error — nothing else changes.
 */

const gmail = require("./gmail");
const ai = require("./ai");

// Same override-for-tests pattern as server.js; leave unset in production.
const SLACK_API_BASE = process.env.SLACK_API_BASE || "https://slack.com/api";

// Workspace host used to deep-link the target conversation (same constant as
// server.js's permalink builder).
const SLACK_WORKSPACE_HOST = "rivian-vw-tech.slack.com";

// Slack section text cap (shared convention across the codebase).
const MAX_SECTION_TEXT = 2990;

/** True when Slack draft delivery is configured (bot token + CoS channel). */
function slackDeliveryConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.COS_CHANNEL);
}

/** POSTs one chat.postMessage as the bot; throws on !ok. */
async function postAsBot(message) {
  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(message),
  });
  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`chat.postMessage failed: ${json.error || `HTTP ${response.status}`}`);
  }
  return json;
}

/** Escapes Slack mrkdwn control chars so drafts render verbatim. */
function escapeMrkdwn(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Deep link to the draft in Gmail (falls back to the Drafts folder). */
function gmailDraftLink(messageId) {
  return messageId
    ? `https://mail.google.com/mail/u/0/#drafts/${messageId}`
    : "https://mail.google.com/mail/u/0/#drafts";
}

/**
 * Resolves the draft text: the request's own `text` wins; otherwise the AI
 * helper generates one from `context` (when configured). Throws with a
 * config-shaped error when neither path can produce text.
 */
async function resolveDraftText(body, kind) {
  if (typeof body.text === "string" && body.text.trim()) {
    return body.text.trim();
  }
  if (!ai.isConfigured()) {
    const err = new Error(
      "No draft text given and AI drafting is not configured (set ANTHROPIC_API_KEY and ANTHROPIC_MODEL, or pass `text`)"
    );
    err.code = "ai_not_configured";
    throw err;
  }
  return ai.generateDraft({
    kind,
    to: body.to,
    subject: body.subject,
    ...(body.context && typeof body.context === "object" ? body.context : {}),
  });
}

/**
 * Delivers one draft. Body shape:
 *   { kind: "email", to, subject?, text? | context? }
 *   { kind: "slack", channel?, to?, text? | context? }
 * Returns { ok: true, ... } or { ok: false, error, status } — never sends
 * anything on Gustavo's behalf.
 *
 * @param {object} body - the POST /drafts request body
 * @returns {Promise<object>}
 */
async function deliverDraft(body) {
  const request = body || {};
  const kind = request.kind;
  if (kind !== "email" && kind !== "slack") {
    return { ok: false, status: 400, error: "bad_request", message: 'Expected { kind: "email"|"slack", ... }' };
  }

  let text;
  try {
    text = await resolveDraftText(request, kind);
  } catch (err) {
    console.error("Draft text resolution failed:", err);
    return {
      ok: false,
      status: err.code === "ai_not_configured" ? 400 : 502,
      error: err.code || "draft_generation_failed",
      message: err.message,
    };
  }

  if (kind === "email") {
    if (!gmail.isConfigured()) {
      return { ok: false, status: 400, error: "gmail_not_configured" };
    }
    if (typeof request.to !== "string" || !request.to) {
      return { ok: false, status: 400, error: "bad_request", message: "Email drafts need a `to` address" };
    }
    let draft;
    try {
      draft = await gmail.createDraft({ to: request.to, subject: request.subject || "", body: text });
    } catch (err) {
      console.error("Gmail draft creation failed:", err);
      return { ok: false, status: 502, error: "gmail_draft_failed", message: err.message };
    }
    const link = gmailDraftLink(draft.messageId);

    // Best-effort heads-up in the CoS channel with the "Open in Gmail
    // Drafts" button; the draft exists either way.
    let notified = false;
    if (slackDeliveryConfigured()) {
      try {
        await postAsBot({
          channel: process.env.COS_CHANNEL,
          text: "📧 Email draft ready — review and send it yourself in Gmail.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `📧 *Email draft ready* — to ${escapeMrkdwn(request.to)}${
                  request.subject ? `, “${escapeMrkdwn(request.subject)}”` : ""
                }. Nothing was sent.`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "draft_open_gmail",
                  text: { type: "plain_text", text: "📬 Open in Gmail Drafts", emoji: true },
                  url: link,
                },
              ],
            },
          ],
        });
        notified = true;
      } catch (err) {
        console.error("CoS-channel draft notification failed:", err);
      }
    }
    return { ok: true, kind, draft_id: draft.id, link, notified };
  }

  // kind === "slack"
  if (!slackDeliveryConfigured()) {
    return { ok: false, status: 400, error: "cos_channel_not_configured" };
  }
  const targetChannel = typeof request.channel === "string" && request.channel ? request.channel : null;
  const conversationLink = targetChannel
    ? `https://${SLACK_WORKSPACE_HOST}/archives/${targetChannel}`
    : null;

  const header = `💬 *Slack draft ready*${request.to ? ` — for ${escapeMrkdwn(request.to)}` : ""}. Copy, paste and send it yourself — nothing was sent.`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: header } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${escapeMrkdwn(text).slice(0, MAX_SECTION_TEXT - 6)}\`\`\``,
      },
    },
  ];
  if (conversationLink) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "draft_open_conversation",
          text: { type: "plain_text", text: "🔗 Open the conversation", emoji: true },
          url: conversationLink,
        },
      ],
    });
  }

  try {
    const posted = await postAsBot({
      channel: process.env.COS_CHANNEL,
      text: "💬 Slack draft ready — copy and paste it yourself.",
      blocks,
    });
    return { ok: true, kind, ts: posted.ts, channel: process.env.COS_CHANNEL, conversation_link: conversationLink };
  } catch (err) {
    console.error("Slack draft delivery failed:", err);
    return { ok: false, status: 502, error: "slack_draft_failed", message: err.message };
  }
}

module.exports = {
  deliverDraft,
  slackDeliveryConfigured,
};
