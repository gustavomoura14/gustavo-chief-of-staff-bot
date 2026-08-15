"use strict";

/**
 * App Home "bandwidth meter" view builder.
 *
 * buildHomeView() turns the /update-home payload into a Slack App Home view
 * ({ type: "home", blocks: [...] }). Every numeric field is optional - only
 * fields actually present in the payload are rendered, so a sparse payload
 * never produces empty rows.
 *
 * View shape (top to bottom):
 *   1. header block - "📊 Bandwidth — {date_label}"
 *   2. (when meeting/focus hours are known) a 10-segment █/░ meter of
 *      today's meeting load with a percentage, plus a plain-English read:
 *      🟢 Light day (<34%), 🟡 Balanced (34-67%), 🔴 Meeting-heavy (>67%)
 *   3. a fields section: meetings today, open focus time, meetings this
 *      week, pending items, new today, on call
 *   4. (when `burndown.baseline` > 0) a burn-down bar: 10-segment █/░ bar of
 *      the cleared fraction, "X of Y cleared", and a "💬 N Slack | 📧 N Email"
 *      breakdown — or a "🎉 Inbox Zero!" header when current === 0
 *   5. (when `tasks` is a non-empty array) a "📥 Triage" board: one section
 *      row per task (source icon + text + inline "open" link) with a
 *      "✅ Complete" accessory button (action_id "task_complete"), capped at
 *      MAX_TRIAGE_TASKS rows plus an "…and N more" context line
 *   6. one context block per `notes` line
 *   7. a final "Updated {ISO time}" context line
 */

const METER_SEGMENTS = 10;
const BURNDOWN_SEGMENTS = 10;

// Slack caps a Home view at 100 blocks; each triage task costs 1 block, so
// capping at 20 leaves ample room for the meter/fields/notes sections.
const MAX_TRIAGE_TASKS = 20;

// Slack caps a button's `value` at 2000 characters.
const BUTTON_VALUE_MAX = 2000;

const TASK_SOURCE_ICONS = { slack: "💬", email: "📧", manual: "📝" };

/** True for any finite number (the only values we render as numbers). */
function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Formats hours compactly: 2 -> "2h", 4.5 -> "4.5h". */
function hours(value) {
  return `${value}h`;
}

/**
 * Computes today's meeting-load meter from meeting/focus hours.
 * Returns null when neither number is present (nothing to draw); a missing
 * side is treated as 0, and a 0-hour day renders as 0% (Light day).
 *
 * @param {number|undefined} meetingHours
 * @param {number|undefined} focusHours
 * @returns {{bar: string, percent: number, label: string, emoji: string}|null}
 */
function computeMeter(meetingHours, focusHours) {
  if (!isNum(meetingHours) && !isNum(focusHours)) return null;

  const meetings = isNum(meetingHours) ? meetingHours : 0;
  const focus = isNum(focusHours) ? focusHours : 0;
  const total = meetings + focus;
  const load = total > 0 ? meetings / total : 0;

  const percent = Math.round(load * 100);
  const filled = Math.round(load * METER_SEGMENTS);
  const bar = "█".repeat(filled) + "░".repeat(METER_SEGMENTS - filled);

  let label;
  let emoji;
  if (percent < 34) {
    label = "Light day";
    emoji = "🟢";
  } else if (percent <= 67) {
    label = "Balanced";
    emoji = "🟡";
  } else {
    label = "Meeting-heavy";
    emoji = "🔴";
  }

  return { bar, percent, label, emoji };
}

/**
 * Serializes a triage task into a "task_complete" button `value` that stays
 * within Slack's 2000-char cap, truncating the task text (and, as a last
 * resort, dropping the link) when needed.
 *
 * @param {{id: string, text?: string, source?: string, link?: string}} task
 * @returns {string} JSON string {taskId, text, source, link}
 */
function buildTaskValue(task) {
  const value = {
    taskId: task.id,
    text: typeof task.text === "string" ? task.text : "",
    source: task.source || "manual",
    link: typeof task.link === "string" && task.link ? task.link : null,
  };

  let json = JSON.stringify(value);
  while (json.length > BUTTON_VALUE_MAX && value.text.length > 0) {
    // Chop generously and re-measure: JSON escaping means char counts don't
    // map 1:1, so a shrink-and-recheck loop is the simple correct approach.
    value.text = `${value.text.slice(0, Math.max(0, value.text.length - (json.length - BUTTON_VALUE_MAX) - 1))}…`;
    json = JSON.stringify(value);
    if (value.text === "…") break;
  }
  if (json.length > BUTTON_VALUE_MAX) {
    value.link = null; // pathological link length - the queue entry loses it
    json = JSON.stringify(value);
  }
  return json;
}

/**
 * Builds the burn-down section blocks (divider + bar/celebration +
 * breakdown). Returns [] when baseline is absent, non-numeric, or <= 0.
 *
 * @param {{baseline?: number, current?: number, slack_unreads?: number,
 *          email_unreads?: number}|undefined} burndown
 * @returns {Array<object>}
 */
function buildBurndownBlocks(burndown) {
  if (!burndown || !isNum(burndown.baseline) || burndown.baseline <= 0) {
    return [];
  }

  const baseline = burndown.baseline;
  const current = isNum(burndown.current) ? burndown.current : baseline;
  const blocks = [{ type: "divider" }];

  if (current === 0) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "🎉 Inbox Zero!", emoji: true },
    });
  } else {
    const cleared = Math.min(1, Math.max(0, (baseline - current) / baseline));
    const filled = Math.round(cleared * BURNDOWN_SEGMENTS);
    const bar = "█".repeat(filled) + "░".repeat(BURNDOWN_SEGMENTS - filled);
    const clearedCount = Math.max(0, Math.min(baseline, baseline - current));
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🔥 Inbox burn-down*\n\`${bar}\` *${clearedCount} of ${baseline} cleared*`,
      },
    });
  }

  if (isNum(burndown.slack_unreads) || isNum(burndown.email_unreads)) {
    const slackN = isNum(burndown.slack_unreads) ? burndown.slack_unreads : 0;
    const emailN = isNum(burndown.email_unreads) ? burndown.email_unreads : 0;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `💬 ${slackN} Slack | 📧 ${emailN} Email` }],
    });
  }

  return blocks;
}

/**
 * Builds the "📥 Triage" board blocks: one section row per task with a
 * "✅ Complete" accessory button, capped at MAX_TRIAGE_TASKS with an
 * "…and N more" context line. Returns [] when there are no valid tasks.
 *
 * @param {Array<{id: string, text: string, source?: string, link?: string,
 *                status?: string}>|undefined} tasks
 * @returns {Array<object>}
 */
function buildTriageBlocks(tasks) {
  const valid = (Array.isArray(tasks) ? tasks : []).filter(
    (task) => task && typeof task.text === "string" && task.text.trim() !== ""
  );
  if (valid.length === 0) return [];

  const blocks = [
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "📥 Triage", emoji: true },
    },
  ];

  valid.slice(0, MAX_TRIAGE_TASKS).forEach((task, index) => {
    const icon = TASK_SOURCE_ICONS[task.source] || TASK_SOURCE_ICONS.manual;
    const doing = task.status === "doing" ? " 🔄" : "";
    let text = `${icon}${doing} ${task.text}`;
    if (typeof task.link === "string" && task.link) {
      text += ` · <${task.link}|open>`;
    }
    blocks.push({
      // Stable block_id lets /slack/interactions surgically remove this row
      // from payload.view.blocks for instant feedback on ✅ Complete.
      type: "section",
      block_id: `task_${task.id !== undefined && task.id !== null ? task.id : index}`,
      text: { type: "mrkdwn", text },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "✅ Complete", emoji: true },
        action_id: "task_complete",
        value: buildTaskValue(task),
      },
    });
  });

  if (valid.length > MAX_TRIAGE_TASKS) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `…and ${valid.length - MAX_TRIAGE_TASKS} more` },
      ],
    });
  }

  return blocks;
}

/**
 * Builds the App Home view for views.publish.
 *
 * @param {object} payload - the /update-home request body (see README)
 * @returns {{type: "home", blocks: Array<object>}}
 */
function buildHomeView(payload) {
  const {
    date_label,
    meeting_hours_today,
    focus_hours_today,
    meetings_this_week,
    meeting_hours_week,
    pending_items,
    new_today,
    on_call,
    notes,
    burndown,
    tasks,
  } = payload || {};

  const blocks = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📊 Bandwidth — ${date_label || "today"}`,
      emoji: true,
    },
  });

  // --- Today's meeting-load meter -----------------------------------------
  const meter = computeMeter(meeting_hours_today, focus_hours_today);
  if (meter) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`${meter.bar}\` *${meter.percent}%* meeting load\n${meter.emoji} ${meter.label}`,
      },
    });
  }

  // --- Stats fields (only fields actually present) ------------------------
  const fields = [];
  if (isNum(meeting_hours_today)) {
    fields.push(`*Meetings today:*\n${hours(meeting_hours_today)}`);
  }
  if (isNum(focus_hours_today)) {
    fields.push(`*Open focus time:*\n${hours(focus_hours_today)}`);
  }
  if (isNum(meetings_this_week) || isNum(meeting_hours_week)) {
    const count = isNum(meetings_this_week) ? `${meetings_this_week}` : null;
    const hrs = isNum(meeting_hours_week) ? hours(meeting_hours_week) : null;
    const value = count && hrs ? `${count} (${hrs})` : count || hrs;
    fields.push(`*Meetings this week:*\n${value}`);
  }
  if (isNum(pending_items)) {
    fields.push(`*Pending items:*\n${pending_items}`);
  }
  if (isNum(new_today)) {
    fields.push(`*New today:*\n${new_today}`);
  }
  if (typeof on_call === "boolean") {
    fields.push(`*On call:*\n${on_call ? "🔴 yes" : "—"}`);
  }

  if (fields.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    });
  }

  // --- Burn-down bar (above triage) ----------------------------------------
  blocks.push(...buildBurndownBlocks(burndown));

  // --- Triage board ----------------------------------------------------------
  blocks.push(...buildTriageBlocks(tasks));

  // --- Notes ---------------------------------------------------------------
  const noteLines = Array.isArray(notes)
    ? notes.filter((line) => typeof line === "string" && line.trim() !== "")
    : [];
  if (noteLines.length > 0) {
    blocks.push({ type: "divider" });
    noteLines.forEach((line) => {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `📌 ${line}` }],
      });
    });
  }

  // --- Footer --------------------------------------------------------------
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Updated ${new Date().toISOString()} · refreshed by the morning brief and EOD close-out.`,
      },
    ],
  });

  return { type: "home", blocks };
}

module.exports = {
  buildHomeView,
  computeMeter,
  buildBurndownBlocks,
  buildTriageBlocks,
  buildTaskValue,
  MAX_TRIAGE_TASKS,
};
