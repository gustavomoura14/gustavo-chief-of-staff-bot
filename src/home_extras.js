"use strict";

/**
 * Glue for the config-gated App Home extra sections — 📧 Gmail cleanup,
 * 💬 Slack needs you, and 📅 Calendar quick actions — so server.js needs
 * exactly three tiny hooks:
 *
 *   1. gatherHomeExtras()   - async data fetch (parallel, each feature
 *                             guarded; unconfigured features cost nothing)
 *   2. buildExtrasBlocks()  - block assembly, passed into buildHomeView()
 *   3. handleExtraAction()  - the /slack/interactions branch for the new
 *                             buttons; returns false for every other
 *                             action_id so existing handling is untouched
 */

const gmail = require("./gmail");
const slackUser = require("./slack_user");
const { CALENDAR_BUTTONS, buildCalendarBlocks } = require("./calendar");

// Slack caps a section block's text at 3000 chars (same as server.js).
const MAX_SECTION_TEXT = 2990;

const CALENDAR_ACTION_IDS = new Set(CALENDAR_BUTTONS.map((b) => b.action_id));

/**
 * Fetches the data every extra section needs, in parallel. Each feature is
 * internally guarded: unconfigured ones resolve to { configured: false }
 * instantly (no network), and failures resolve to { configured, error }.
 *
 * @returns {Promise<{gmail: object, slack: object}>}
 */
async function gatherHomeExtras() {
  const [gmailData, slackData] = await Promise.all([
    gmail.getHomeData(),
    slackUser.getHomeData(),
  ]);
  return { gmail: gmailData, slack: slackData };
}

/**
 * Assembles the extra sections' blocks in render order: Gmail cleanup,
 * Slack needs-you, Calendar quick actions (the calendar section always
 * renders — it needs no config).
 *
 * @param {{gmail?: object, slack?: object}|undefined} extras
 * @returns {Array<object>}
 */
function buildExtrasBlocks(extras) {
  const data = extras || {};
  return [
    ...gmail.buildGmailBlocks(data.gmail),
    ...slackUser.buildNeedsYouBlocks(data.slack),
    ...buildCalendarBlocks(),
  ];
}

/**
 * Rewrites ONE button (by action_id) inside the Home view's
 * `calendar_actions` row: its text becomes `newLabel` and its action_id
 * gets a "_queued" suffix — a no-op the unknown-action branch in server.js
 * ignores — so the same button can't queue twice (same pattern as
 * brief_refresh). Returns the new blocks array, or null when nothing
 * matched.
 */
function rewriteCalendarButton(viewBlocks, actionId, newLabel) {
  let changed = false;
  const newBlocks = (viewBlocks || []).map((block) => {
    if (!block || block.block_id !== "calendar_actions" || !Array.isArray(block.elements)) {
      return block;
    }
    return {
      ...block,
      elements: block.elements.map((el) => {
        if (!el || el.action_id !== actionId) return el;
        changed = true;
        return {
          ...el,
          action_id: `${actionId}_queued`,
          text: { type: "plain_text", text: newLabel, emoji: true },
        };
      }),
    };
  });
  return changed ? newBlocks : null;
}

/**
 * Handles clicks on the extra sections' buttons. Returns true when the
 * action was one of ours (calendar quick actions / Gmail archive) — the
 * caller then stops — and false otherwise. `ctx` is supplied by server.js:
 * { delegations, saveDelegations, republishHomeView }.
 *
 * @param {object} action - payload.actions[0]
 * @param {object} payload - the parsed Slack interactivity payload
 * @param {{delegations: Array<object>, saveDelegations: Function,
 *          republishHomeView: Function}} ctx
 * @returns {Promise<boolean>}
 */
async function handleExtraAction(action, payload, ctx) {
  const view = payload.view;
  const userId = payload.user && payload.user.id;
  const canRepublish = view && view.type === "home" && Array.isArray(view.blocks) && userId;

  // --- 📅 Calendar quick actions -------------------------------------------
  // Queue a "calendar_block" / "calendar_move" delegation entry carrying the
  // button's duration/day payload, then mark the clicked button "✅ Queued"
  // in place (Home clicks have no response_url, so views.publish it is).
  if (CALENDAR_ACTION_IDS.has(action.action_id)) {
    let value = {};
    try {
      value = JSON.parse(action.value) || {};
    } catch (err) {
      console.error(`${action.action_id} click carried an unparseable value - queueing bare entry`);
    }
    const isMove = value.type === "calendar_move";
    ctx.delegations.push({
      id: `${isMove ? "calmove" : "calblock"}-${Date.now()}`,
      type: isMove ? "calendar_move" : "calendar_block",
      ...(isMove
        ? {}
        : {
            duration_minutes: value.duration_minutes || 30,
            day: value.day || "today",
            when: value.when || null,
            title: value.title || "Focus time",
          }),
      clickedAt: new Date().toISOString(),
      status: "pending",
    });
    ctx.saveDelegations();

    if (canRepublish) {
      const newBlocks = rewriteCalendarButton(
        view.blocks,
        action.action_id,
        "✅ Queued — next sweep"
      );
      if (newBlocks) {
        await ctx.republishHomeView(userId, newBlocks, action.action_id);
      }
    }
    return true;
  }

  // --- 📧 "🗑️ Archive N low-priority" ---------------------------------------
  // Runs the archive INLINE (the bot talks to Gmail itself; nothing to
  // delegate): a fresh triage picks the threads server-side — the button
  // value's count is display-only — and gmail.archiveLowPriority() enforces
  // the archive-only / skip-starred / skip-replied invariants. Then the
  // `gmail_low` section is rewritten in place with the outcome.
  if (action.action_id === "gmail_archive_low") {
    let suffix;
    try {
      const { archived, skipped } = await gmail.archiveLowPriority();
      suffix = ` → 🗑️ archived ${archived}${skipped ? ` (kept ${skipped} starred/replied)` : ""}`;
    } catch (err) {
      console.error("gmail_archive_low failed:", err);
      suffix = " → ⚠️ archive failed (see logs)";
    }

    if (canRepublish) {
      let changed = false;
      const newBlocks = view.blocks.map((block) => {
        if (
          !block ||
          block.block_id !== "gmail_low" ||
          !block.text ||
          typeof block.text.text !== "string"
        ) {
          return block;
        }
        changed = true;
        const { accessory, ...rest } = block; // drop the clicked button
        let newText = `${rest.text.text}${suffix}`;
        if (newText.length > MAX_SECTION_TEXT) {
          newText = `${newText.slice(0, MAX_SECTION_TEXT - 1)}…`;
        }
        return { ...rest, text: { ...rest.text, text: newText } };
      });
      if (changed) {
        await ctx.republishHomeView(userId, newBlocks, "gmail_archive_low");
      }
    }
    return true;
  }

  return false;
}

module.exports = {
  gatherHomeExtras,
  buildExtrasBlocks,
  handleExtraAction,
};
