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
 *   4. one context block per `notes` line
 *   5. a final "Updated {ISO time}" context line
 */

const METER_SEGMENTS = 10;

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

module.exports = { buildHomeView, computeMeter };
