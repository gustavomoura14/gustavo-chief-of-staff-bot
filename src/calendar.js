"use strict";

/**
 * "📅 Calendar" quick-actions App Home section.
 *
 * Always renders (no config needed): the block buttons enqueue a
 * "calendar_block" delegation entry (carrying duration/day/label) that the
 * EXISTING hourly assistant pickup drains via GET /delegations/pending and
 * executes against the calendar, while "Flag a meeting to move" opens the
 * meeting-move modal below — its SUBMISSION queues the "calendar_move"
 * entry, now carrying which meeting and what change. The bot itself never
 * touches the calendar; this is the same click → queue → sweep pattern
 * every other Home button uses.
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

// ---------------------------------------------------------------------------
// "Flag a meeting to move" modal. Clicking the button above no longer queues
// a bare (meeting-less) calendar_move entry — it opens this modal instead:
// pick one upcoming meeting (from the list the latest /render-brief payload
// persisted server-side) and say where/when to move it. Submitting queues a
// calendar_move delegation carrying the meeting's title/start/organizer plus
// the requested change — complete enough for the hourly sweep to act on.
// ---------------------------------------------------------------------------

const MEETING_MOVE_CALLBACK_ID = "calendar_move_modal";
const MEETING_MOVE_SELECT_BLOCK_ID = "meeting_select";
const MEETING_MOVE_SELECT_ACTION_ID = "meeting";
const MEETING_MOVE_INPUT_BLOCK_ID = "move_details";
const MEETING_MOVE_INPUT_ACTION_ID = "details";

// Slack caps static_select option text at 75 chars; keep the list modest.
const MEETING_OPTION_TEXT_MAX = 75;
const MEETING_OPTIONS_MAX = 25;

/** One option's plain_text label: "start — title", truncated to Slack's cap. */
function meetingOptionLabel(meeting) {
  const title = String((meeting && meeting.title) || "(untitled)");
  const start = meeting && meeting.start ? String(meeting.start) : "";
  let label = start ? `${start} — ${title}` : title;
  if (label.length > MEETING_OPTION_TEXT_MAX) {
    label = `${label.slice(0, MEETING_OPTION_TEXT_MAX - 1)}…`;
  }
  return label;
}

/**
 * Builds the meeting-move modal view. With meetings on file: a static_select
 * of the upcoming meetings (option `value` is the meeting's INDEX in the
 * stored list — the submission handler reads the full meeting back from
 * storage) plus a free-text "move it where/when" input. With none: an
 * explanatory note and no submit button.
 *
 * @param {Array<{title: string, start?: string, organizer?: string}>} meetings
 * @returns {object} Slack modal view for views.open
 */
function buildMeetingMoveModal(meetings) {
  const list = (Array.isArray(meetings) ? meetings : []).slice(0, MEETING_OPTIONS_MAX);

  if (list.length === 0) {
    return {
      type: "modal",
      callback_id: MEETING_MOVE_CALLBACK_ID,
      title: { type: "plain_text", text: "Move a meeting", emoji: true },
      close: { type: "plain_text", text: "Close", emoji: true },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_No upcoming meetings on file yet — the next brief will populate this list._",
          },
        },
      ],
    };
  }

  return {
    type: "modal",
    callback_id: MEETING_MOVE_CALLBACK_ID,
    title: { type: "plain_text", text: "Move a meeting", emoji: true },
    submit: { type: "plain_text", text: "Queue move", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks: [
      {
        type: "input",
        block_id: MEETING_MOVE_SELECT_BLOCK_ID,
        label: { type: "plain_text", text: "Which meeting?", emoji: true },
        element: {
          type: "static_select",
          action_id: MEETING_MOVE_SELECT_ACTION_ID,
          placeholder: { type: "plain_text", text: "Pick a meeting", emoji: true },
          options: list.map((meeting, index) => ({
            text: { type: "plain_text", text: meetingOptionLabel(meeting), emoji: true },
            value: String(index),
          })),
        },
      },
      {
        type: "input",
        block_id: MEETING_MOVE_INPUT_BLOCK_ID,
        label: { type: "plain_text", text: "Move it where/when?", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: MEETING_MOVE_INPUT_ACTION_ID,
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "e.g. push to Thursday afternoon, or shorten to 30 min",
          },
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Queues a move request for the hourly sweep — nothing changes on the calendar until then.",
          },
        ],
      },
    ],
  };
}

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
  buildMeetingMoveModal,
  MEETING_MOVE_CALLBACK_ID,
  MEETING_MOVE_SELECT_BLOCK_ID,
  MEETING_MOVE_SELECT_ACTION_ID,
  MEETING_MOVE_INPUT_BLOCK_ID,
  MEETING_MOVE_INPUT_ACTION_ID,
};
