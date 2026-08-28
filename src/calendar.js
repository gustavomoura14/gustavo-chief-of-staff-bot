"use strict";

/**
 * "📅 Calendar" quick-actions App Home section.
 *
 * Always renders (no config needed): each button enqueues a delegation
 * entry — new types "calendar_block" (carrying duration/day/label) and
 * "calendar_move" — that the EXISTING hourly assistant pickup drains via
 * GET /delegations/pending and executes against the calendar. The bot
 * itself never touches the calendar; this is the same click → queue →
 * sweep pattern every other Home button uses.
 */

// One entry per button; `value` is what the click handler enqueues (minus
// the queue bookkeeping fields it adds).
const CALENDAR_BUTTONS = [
  {
    action_id: "calendar_block_now",
    label: "🧠 Block 30m heads-down now",
    value: {
      type: "calendar_block",
      duration_minutes: 30,
      day: "today",
      when: "now",
      title: "Heads-down focus",
    },
  },
  {
    action_id: "calendar_block_cleanup",
    label: "🧹 Block Slack+Gmail cleanup tomorrow",
    value: {
      type: "calendar_block",
      duration_minutes: 45,
      day: "tomorrow",
      title: "Slack + Gmail cleanup",
    },
  },
  {
    action_id: "calendar_move_flag",
    label: "📌 Flag a meeting to move",
    value: { type: "calendar_move" },
  },
];

/**
 * Builds the "📅 Calendar" blocks: divider + header + one actions row
 * (block_id `calendar_actions`, so the click handler can rewrite the
 * clicked button to "✅ Queued" in place) + a how-it-works context line.
 *
 * @returns {Array<object>}
 */
function buildCalendarBlocks() {
  return [
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "📅 Calendar", emoji: true } },
    {
      type: "actions",
      block_id: "calendar_actions",
      elements: CALENDAR_BUTTONS.map((button) => ({
        type: "button",
        action_id: button.action_id,
        text: { type: "plain_text", text: button.label, emoji: true },
        value: JSON.stringify(button.value),
      })),
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Each button queues an entry the hourly assistant sweep executes.",
        },
      ],
    },
  ];
}

module.exports = {
  CALENDAR_BUTTONS,
  buildCalendarBlocks,
};
