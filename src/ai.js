"use strict";

/**
 * Thin Anthropic Messages API helper (plain fetch, no SDK — same pattern as
 * gmail.js / slack_user.js).
 *
 * Gated exactly like the other optional integrations: BOTH env vars must be
 * set or isConfigured() is false and no request is ever made — the bot runs
 * exactly as before:
 *   - ANTHROPIC_API_KEY: an API key Gustavo creates himself (see SETUP.md)
 *   - ANTHROPIC_MODEL:   the model id to use. Deliberately NOT defaulted in
 *     code — the model choice lives in config, not the repo.
 *
 * First (and only) consumer: generateDraft(), used by src/drafts.js to write
 * email/Slack reply drafts. Drafts are DRAFTS: nothing produced here is ever
 * sent anywhere automatically (see drafts.js).
 */

// Overridable ONLY so local tests can point at a mock server (same pattern
// as SLACK_API_BASE / GMAIL_API_BASE); leave unset in production.
const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Drafts are short; this caps cost per call, not draft quality.
const MAX_DRAFT_TOKENS = 1024;

/** True when both Anthropic env vars are set. */
function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL);
}

/**
 * One non-streaming Messages API call; returns the concatenated text blocks.
 * Throws on HTTP errors, refusals, and empty responses.
 *
 * @param {{system?: string, prompt: string, maxTokens?: number}} options
 * @returns {Promise<string>}
 */
async function complete({ system, prompt, maxTokens }) {
  if (!isConfigured()) {
    throw new Error("AI drafting is not configured (set ANTHROPIC_API_KEY and ANTHROPIC_MODEL)");
  }

  const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL,
      max_tokens: maxTokens || MAX_DRAFT_TOKENS,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Anthropic request failed: ${(json.error && json.error.message) || `HTTP ${response.status}`}`
    );
  }
  // Guard stop_reason before reading content — a refusal is a 200 with no
  // usable draft in it.
  if (json.stop_reason === "refusal") {
    throw new Error("Anthropic declined to draft this request");
  }

  const text = (json.content || [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) {
    throw new Error("Anthropic response contained no text");
  }
  return text;
}

const DRAFT_SYSTEM_PROMPT =
  "You draft replies on behalf of Gustavo, a chief of staff's principal. " +
  "Write ONLY the draft body — no preamble, no commentary, no signature " +
  "placeholders. Match the medium: emails get a greeting and sign-off " +
  "('Gustavo'); Slack messages are short and conversational. Be concise, " +
  "warm, and direct. The draft is NEVER sent automatically — Gustavo reviews " +
  "and sends it himself — so leave anything you are unsure about in " +
  "[brackets] for him to fill in.";

/**
 * Drafts an email or Slack reply from a loose context object. Every field is
 * optional except that SOMETHING must describe what to write.
 *
 * @param {{kind?: "email"|"slack", to?: string, subject?: string,
 *          instructions?: string, thread?: string}} context
 * @returns {Promise<string>} the draft body text
 */
async function generateDraft(context) {
  const ctx = context || {};
  const lines = [`Draft a ${ctx.kind === "email" ? "reply email" : "Slack reply"}.`];
  if (ctx.to) lines.push(`Recipient: ${ctx.to}`);
  if (ctx.subject) lines.push(`Subject: ${ctx.subject}`);
  if (ctx.thread) lines.push(`Conversation so far:\n${ctx.thread}`);
  if (ctx.instructions) lines.push(`What Gustavo wants to say: ${ctx.instructions}`);
  if (lines.length === 1) {
    throw new Error("generateDraft needs at least one of: to, subject, thread, instructions");
  }
  return complete({ system: DRAFT_SYSTEM_PROMPT, prompt: lines.join("\n\n") });
}

module.exports = {
  isConfigured,
  complete,
  generateDraft,
};
