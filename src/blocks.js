"use strict";

/**
 * Block Kit builders for the Chief of Staff "Morning Brief" message, plus
 * the stateless up/down/done logic used to re-rank recommendations and mark
 * them done (done items stay in the list, rendered struck-through with no
 * buttons, sorted to the bottom).
 *
 * Message shape (top to bottom):
 *   1. header block - date-stamped title, e.g. "☀️ Morning Brief — Friday, August 14"
 *   2. (optional) priority_recap section, bold/italic
 *   2b. one actions block (block_id `voice_actions`) with a "🎙️ Hear it"
 *       link button (action_id `voice_open`) pointing at the voice-briefing
 *       project (VOICE_PROJECT_URL env var, with a built-in default) and a
 *       "🔄 Refresh brief" action button (action_id `brief_refresh`) that
 *       queues a "refresh" delegation entry
 *   3. for each entry in `sections`: consecutive PLAIN items (strings or
 *      {text, link?, flag?} objects) are condensed into ONE section block -
 *      the bold title on the first line (hyperlinked when the section
 *      carries a `title_link`, or when the title looks like "Ben 1:1 prep" -
 *      see sectionTitleMrkdwn), then one "• item" line per item (flag as an
 *      italic suffix, link as an inline `<url|open>` mrkdwn link) - keeping
 *      the whole message well under Slack's hard cap of 50 blocks per
 *      message. Three further item shapes exist:
 *        - ACTIONABLE items ({text, link?, id, action: {type, ...}, due?,
 *          draft?}) render as their own section block (text hyperlinked to
 *          `link` when usable) with an accessory button - action.type
 *          "archive_email" → "🗑️ Archive" (action_id `sec_item_archive`),
 *          "done" → "✅ Done" (action_id `sec_item_done`) - plus an actions
 *          row (block_id `sec_item_actions_<id>`) holding "⏰ Snooze"
 *          (`sec_item_snooze`, value carries `due` when set) and "✖️ Not for
 *          me" (`sec_item_dismiss`), and a "📝 View draft" button when the
 *          item carries a `draft` string. Button values are compact JSON
 *          {id, type, gmail_thread_id?, due?, text (truncated), link?}.
 *        - DRAFT items ({text, link?, draft}, no action) render as their own
 *          section block with a "📝 View draft" accessory button (action_id
 *          `sec_item_view_draft`, value {type: "view_draft", draft}) - the
 *          interactions handler opens a display-only modal with the draft.
 *        - CALENDAR items ({time, title, link?, note?}, no action) render as
 *          compact "`8:00–9:00`  *<link|Title>* — note" lines, one section
 *          block per run of consecutive calendar items (no per-item blocks
 *          or dividers).
 *      A divider is inserted between each named section.
 *   4. (optional) recommendations: a bold "Reply-worthy" header, then one
 *      section+actions block pair per recommendation. The section half is
 *      built like a plain item and carries a stable `rec_text_<id>` block_id
 *      (done/delegated rows, which get no actions block, keep the legacy
 *      link accessory instead). The actions half leads with a "🔗 Open"
 *      LINK button (action_id `item_open__<id>`, client-side, acked as a
 *      no-op by the interactions handler) when the rec carries a link, then
 *      carries three buttons - 🔼 (item_up), 🔽 (item_down), ✅ (item_done) -
 *      plus a fourth "🤖 Do it" button (item_delegate) when the
 *      recommendation is marked `delegatable: true`. Two further extras are
 *      CONDITIONAL and
 *      default to off: a "📌 Park for 1:1" button (item_park, static value)
 *      only when the rec is marked `parkable: true`, and a "🙋 Delegate
 *      to..." users_select (item_delegate_person, no value) only when it is
 *      marked `delegatable_person: true`. Payloads predating these flags
 *      render neither, so old callers are unaffected.
 *      Button `value` is a JSON string of
 *      `{ items: [...all current recommendations, in order...], actedId }`,
 *      so the whole ordered list travels with every click. No DB, no
 *      server-side state. To stay under Slack's 2000-char limit on button
 *      values, stored items carry {id, text (truncated), done, link (kept
 *      only while the total value stays under ~1900 chars - dropped
 *      wholesale otherwise)}, plus `d:1` when delegatable, `p:1` when
 *      parkable, `dp:1` when person-delegatable and `delegated:true` once
 *      delegated; when links were dropped, the interactions handler recovers
 *      them from the original message's 🔗 Open button URLs (or legacy
 *      `rec_text_<id>` accessory URLs).
 *
 *      Delegated items (🤖 Do it was clicked) stay in place - not done, not
 *      sorted last - rendered as "🤖 _queued: text_" with ALL buttons
 *      removed.
 *   5. footer: a context block with a "📊 View all in Home" mrkdwn link
 *      pointing at the app's Home tab via Slack's https app_redirect URL
 *      (see buildHomeFooterBlock).
 *
 *      Recommendation ids are normalized before anything is built (see
 *      withUniqueRecIds): each rec's id becomes the suffix of two block_ids,
 *      and Slack rejects an entire message with `invalid_blocks` if any two
 *      blocks share a block_id - so missing or repeated ids are filled in /
 *      de-duplicated rather than allowed to collide.
 */

// Slack hard limits we render against.
const SLACK_MAX_BLOCKS = 50;
const SOFT_MAX_BLOCKS = 45; // our own guard threshold, comfortably below 50
const MAX_SECTION_TEXT = 2990; // Slack section text cap is 3000 chars
const MAX_BUTTON_VALUE = 2000; // Slack button `value` cap
const MAX_BLOCK_ID = 255; // Slack `block_id` cap
const MAX_ACTIONS_ELEMENTS = 25; // Slack cap on elements per `actions` block
const MAX_BUTTON_URL = 3000; // Slack button `url` cap

/**
 * Truncates `text` to at most `max` chars, appending "…" when trimmed.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  if (typeof text !== "string") text = String(text == null ? "" : text);
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Returns `link` verbatim when it is a usable button/anchor URL - a non-empty
 * http(s) string within Slack's 3000-char button-url cap - and null
 * otherwise. Every Open button/accessory is gated on this: an item with a
 * missing or invalid link renders NO Open affordance at all. There is
 * DELIBERATELY no fallback URL anywhere - an Open button either uses the
 * item's own link verbatim or does not exist (a substituted default link,
 * e.g. a canvas, would point the button at the wrong destination).
 *
 * @param {*} link
 * @returns {string|null}
 */
function usableLink(link) {
  if (typeof link !== "string") return null;
  if (!/^https?:\/\//i.test(link)) return null;
  if (link.length > MAX_BUTTON_URL) return null;
  return link;
}

/**
 * Normalizes a section item / recommendation to a {text, link?, flag?}
 * object. Accepts plain strings (a common caller shape) - previously a
 * string item produced a section block with NO text at all (`item.text` is
 * undefined on a string), which Slack rejects with invalid_blocks.
 *
 * @param {string|{text?: any, link?: string, flag?: string}} item
 * @returns {{text: string, link?: string, flag?: string}}
 */
function normalizeItem(item) {
  if (typeof item === "string") return { text: item };
  if (item && typeof item === "object") {
    const normalized = { ...item, text: item.text == null ? "" : String(item.text) };
    // Guard against string-prototype leakage (e.g. String.prototype.link).
    if (typeof normalized.link !== "string") delete normalized.link;
    if (typeof normalized.flag !== "string") delete normalized.flag;
    return normalized;
  }
  return { text: String(item == null ? "" : item) };
}

// ---------------------------------------------------------------------------
// Item-level rendering
// ---------------------------------------------------------------------------

/**
 * Renders a single item's (or recommendation's) markdown text, appending its
 * `flag` (a short label like "overdue") as an italic suffix when present.
 *
 * @param {{text: string, flag?: string}} item
 * @returns {string}
 */
function itemMrkdwn(item) {
  const it = normalizeItem(item);
  let text = it.text || "-";
  if (it.flag) {
    text += `  •  _${it.flag}_`;
  }
  return text;
}

/**
 * Builds a `section` block for one item. If `item.link` is set, attaches a
 * URL button accessory ("Open") - these are handled entirely client-side by
 * Slack (no interactivity request ever hits this server for them).
 *
 * @param {{text: string, link?: string, flag?: string}} item
 * @returns {object} Slack Block Kit `section` block
 */
function buildItemSectionBlock(item) {
  item = normalizeItem(item);
  const block = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncate(itemMrkdwn(item), MAX_SECTION_TEXT),
    },
  };

  if (usableLink(item.link)) {
    block.accessory = {
      type: "button",
      text: {
        type: "plain_text",
        text: "Open",
        emoji: true,
      },
      url: item.link,
    };
  }

  return block;
}

/**
 * Bold, single-line section/header title block (used both for named
 * `sections` titles and the "Reply-worthy" recommendations header).
 *
 * @param {string} title
 * @returns {object} Slack Block Kit `section` block
 */
function buildTitleBlock(title) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${title}*`,
    },
  };
}

// ---------------------------------------------------------------------------
// Header / priority recap
// ---------------------------------------------------------------------------

const DEFAULT_BRIEF_TITLE = "Morning Brief";
const DEFAULT_BRIEF_EMOJI = "☀️";

// Slack caps header-block plain_text at 150 chars.
const MAX_HEADER_TEXT = 150;

/**
 * Date-stamped header block, e.g. "☀️ Morning Brief — Friday, August 14".
 *
 * A custom `title` (e.g. "Week Ahead", "EOD Close-out") replaces the default
 * "Morning Brief". A custom `emoji` is prepended when given; when only a
 * custom title is given, NO default emoji is added (the title may carry its
 * own). With neither, the classic "☀️ Morning Brief" is rendered. The date
 * stamp is always appended.
 *
 * @param {Date} [date]
 * @param {string} [title]
 * @param {string} [emoji]
 * @returns {object} Slack Block Kit `header` block
 */
function buildHeaderBlock(date = new Date(), title, emoji) {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const customTitle = title != null && String(title).trim() !== "" ? String(title).trim() : null;
  const customEmoji = emoji != null && String(emoji).trim() !== "" ? String(emoji).trim() : null;

  const headerText = [
    customEmoji || (customTitle ? null : DEFAULT_BRIEF_EMOJI),
    customTitle || DEFAULT_BRIEF_TITLE,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    type: "header",
    text: {
      type: "plain_text",
      text: truncate(`${headerText} — ${dateStr}`, MAX_HEADER_TEXT),
      emoji: true,
    },
  };
}

/**
 * @param {string} text
 * @returns {object} Slack Block Kit `section` block, bold + italic
 */
function buildPriorityRecapBlock(text) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*_${text}_*`,
    },
  };
}

// ---------------------------------------------------------------------------
// Named sections (e.g. "Urgent", "Calendar conflicts")
// ---------------------------------------------------------------------------

/** Accessory button config per actionable-item action.type (see below). */
const SEC_ITEM_BUTTONS = {
  archive_email: { action_id: "sec_item_archive", label: "🗑️ Archive" },
  done: { action_id: "sec_item_done", label: "✅ Done" },
};

// Item text is truncated to this length inside sec_item_* button values, so
// even with a long link the JSON stays well under Slack's 2000-char cap.
const SEC_ITEM_VALUE_TEXT_MAX = 140;
const SEC_ITEM_VALUE_SOFT_MAX = 1800;

// A snooze value's `due` (the item's own due date, passed through verbatim)
// is capped so it can never blow the button-value budget.
const SEC_ITEM_VALUE_DUE_MAX = 40;

/** Stable block_id prefix for actionable section-item blocks. */
const SEC_ITEM_BLOCK_ID_PREFIX = "sec_item_";

/**
 * Stable block_id prefix for the ⏰/✖️ (and optional "View draft") actions
 * row rendered under each actionable section item. The interactions handler
 * derives one id from the other (`sec_item_<id>` <-> `sec_item_actions_<id>`)
 * to strike the item and drop its buttons together.
 */
const SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX = "sec_item_actions_";

/**
 * True when a section item is an ACTIONABLE object - it carries an `action`
 * with a type we render a button for.
 *
 * @param {any} item
 * @returns {boolean}
 */
function isActionItem(item) {
  return !!(
    item &&
    typeof item === "object" &&
    item.action &&
    SEC_ITEM_BUTTONS[item.action.type]
  );
}

/**
 * True when a section item is a compact CALENDAR object ({time, title}, and
 * no `action` - actionable items win when both shapes are present).
 *
 * @param {any} item
 * @returns {boolean}
 */
function isCalendarItem(item) {
  return !!(
    item &&
    typeof item === "object" &&
    !item.action &&
    typeof item.time === "string" &&
    typeof item.title === "string"
  );
}

/**
 * Renders one calendar item as a compact mrkdwn line:
 * "`8:00–9:00`  *<link|Title>* — note" (note optional; title plain-bold when
 * there is no link).
 *
 * @param {{time: string, title: string, link?: string, note?: string}} item
 * @returns {string}
 */
function calendarItemMrkdwn(item) {
  const title = String(item.title == null ? "" : item.title);
  const titlePart = typeof item.link === "string" ? `*<${item.link}|${title}>*` : `*${title}*`;
  let line = `\`${item.time}\`  ${titlePart}`;
  if (item.note) {
    line += ` — ${item.note}`;
  }
  return line;
}

/**
 * Builds a compact sec_item_* button `value` JSON: {id, type, text
 * (truncated), link?, plus any `extra` fields (e.g. gmail_thread_id, due)}.
 * The link is dropped (never truncated - a cut URL is useless) if it would
 * push the JSON near Slack's 2000-char cap.
 *
 * @param {{text?: any, link?: string, id?: string}} item
 * @param {string} type - the delegation type this button queues
 * @param {object} [extra] - additional short fields to carry
 * @returns {string} JSON string
 */
function buildSecItemValue(item, type, extra) {
  const value = { id: item.id, type, ...(extra || {}) };
  value.text = truncate(String(item.text == null ? "" : item.text), SEC_ITEM_VALUE_TEXT_MAX);
  if (typeof item.link === "string") value.link = item.link;
  let valueJson = JSON.stringify(value);
  if (valueJson.length > SEC_ITEM_VALUE_SOFT_MAX) {
    delete value.link;
    valueJson = JSON.stringify(value);
  }
  return valueJson;
}

/**
 * Builds the blocks for one ACTIONABLE item:
 *   1. a section block - mrkdwn text (hyperlinked to `item.link` when
 *      usable) with an accessory 🗑️ Archive / ✅ Done button whose value is
 *      the compact JSON above (plus gmail_thread_id for archives);
 *   2. an actions row (block_id `sec_item_actions_<id>`) with "⏰ Snooze"
 *      (action_id `sec_item_snooze`, value carries the item's optional `due`
 *      date) and "✖️ Not for me" (action_id `sec_item_dismiss`) - clicking
 *      queues a "snooze" / "dismiss" delegation entry and marks the item in
 *      place. When the item also carries a `draft` string, a "📝 View draft"
 *      button (action_id `sec_item_view_draft`) is appended - it opens a
 *      modal showing the draft, display-only (see buildDraftButton).
 *
 * @param {{text: string, link?: string, id?: string, due?: string, draft?: string, action: {type: string, gmail_thread_id?: string}}} item
 * @returns {Array<object>} [section block, actions block]
 */
function buildActionItemBlocks(item) {
  const config = SEC_ITEM_BUTTONS[item.action.type];
  const text = String(item.text == null ? "" : item.text);

  const extra = {};
  if (typeof item.action.gmail_thread_id === "string") {
    extra.gmail_thread_id = item.action.gmail_thread_id;
  }

  const mrkdwn = usableLink(item.link) ? `<${item.link}|${text}>` : text;

  const sectionBlock = {
    type: "section",
    block_id: `${SEC_ITEM_BLOCK_ID_PREFIX}${item.id}`,
    text: { type: "mrkdwn", text: truncate(mrkdwn, MAX_SECTION_TEXT) },
    accessory: {
      type: "button",
      action_id: config.action_id,
      text: { type: "plain_text", text: config.label, emoji: true },
      value: buildSecItemValue(item, item.action.type, extra),
    },
  };

  return [sectionBlock, buildSecItemExtrasBlock(item)];
}

/**
 * Builds the ⏰ Snooze / ✖️ Not for me actions row for one section item (see
 * buildActionItemBlocks). The snooze value additionally carries the item's
 * `due` date (truncated, optional); a `draft` string appends a "📝 View
 * draft" button.
 *
 * @param {{text: string, link?: string, id?: string, due?: string, draft?: string}} item
 * @returns {object} Slack Block Kit `actions` block
 */
function buildSecItemExtrasBlock(item) {
  const snoozeExtra = {};
  if (typeof item.due === "string" && item.due) {
    snoozeExtra.due = truncate(item.due, SEC_ITEM_VALUE_DUE_MAX);
  }

  const elements = [
    {
      type: "button",
      action_id: "sec_item_snooze",
      text: { type: "plain_text", text: "⏰ Snooze", emoji: true },
      value: buildSecItemValue(item, "snooze", snoozeExtra),
    },
    {
      type: "button",
      action_id: "sec_item_dismiss",
      text: { type: "plain_text", text: "✖️ Not for me", emoji: true },
      value: buildSecItemValue(item, "dismiss"),
    },
  ];

  if (typeof item.draft === "string" && item.draft) {
    elements.push(buildDraftButton(item.draft, item.draft_id));
  }

  return {
    type: "actions",
    block_id: `${SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX}${item.id}`,
    elements,
  };
}

// ---------------------------------------------------------------------------
// "View draft" items (e.g. the Delegated section's ready-to-send nudges)
// ---------------------------------------------------------------------------

// The draft text travels in the button's `value`; kept under this so JSON
// escaping can never push it past Slack's 2000-char button-value cap.
const DRAFT_VALUE_SOFT_MAX = 1900;

/**
 * True when a section item carries a `draft` string (a ready-to-send nudge
 * text) but no actionable `action` (actionable items win - they render the
 * draft button inside their extras row instead).
 *
 * @param {any} item
 * @returns {boolean}
 */
function isDraftItem(item) {
  return !!(
    item &&
    typeof item === "object" &&
    !item.action &&
    typeof item.draft === "string" &&
    item.draft
  );
}

/**
 * Builds the "📝 View draft" button (action_id `sec_item_view_draft`).
 * Clicking opens a modal showing the draft in a copyable code block -
 * display only, nothing is sent.
 *
 * When the server stored the full draft text server-side (see /render-brief
 * in server.js), `draftId` is set and the value is just JSON
 * {type: "view_draft", draft_id} - the interactions handler reads the FULL
 * text back from storage, so drafts are no longer capped by Slack's
 * 2000-char button-value limit. Without an id (older callers/messages) the
 * legacy inline shape {type: "view_draft", draft} is kept, with the draft
 * text truncated (shrink-and-recheck, since JSON escaping means char counts
 * don't map 1:1) to stay under that cap.
 *
 * @param {string} draft
 * @param {string} [draftId] - server-side storage key for the full draft
 * @returns {object} Slack Block Kit button element
 */
function buildDraftButton(draft, draftId) {
  let value;
  if (typeof draftId === "string" && draftId) {
    value = JSON.stringify({ type: "view_draft", draft_id: draftId });
  } else {
    let text = String(draft);
    value = JSON.stringify({ type: "view_draft", draft: text });
    while (value.length > DRAFT_VALUE_SOFT_MAX && text.length > 1) {
      const overshoot = value.length - DRAFT_VALUE_SOFT_MAX;
      text = `${text.slice(0, Math.max(0, text.length - overshoot - 1))}…`;
      value = JSON.stringify({ type: "view_draft", draft: text });
    }
  }
  return {
    type: "button",
    action_id: "sec_item_view_draft",
    text: { type: "plain_text", text: "📝 View draft", emoji: true },
    value,
  };
}

/**
 * Builds the section block for one DRAFT-carrying plain item: the usual item
 * mrkdwn (with an inline `<url|open>` link when present, like other plain
 * items) plus a "📝 View draft" accessory button.
 *
 * @param {{text: string, link?: string, flag?: string, draft: string}} raw
 * @returns {object} Slack Block Kit `section` block
 */
function buildDraftItemBlock(raw) {
  const item = normalizeItem(raw);
  let line = `• ${itemMrkdwn(item)}`;
  if (item.link) {
    line += `  <${item.link}|open>`;
  }
  return {
    type: "section",
    text: { type: "mrkdwn", text: truncate(line, MAX_SECTION_TEXT) },
    accessory: buildDraftButton(raw.draft, raw.draft_id),
  };
}

/**
 * Canvas linked from any section titled like "Ben 1:1 prep" (see
 * sectionTitleMrkdwn) when the payload carries no explicit `title_link`.
 */
const BEN_ONE_ON_ONE_CANVAS_URL =
  "https://rivian-vw-tech.slack.com/docs/T07MV6787FY/F0AASUBTMJA";

/**
 * Renders a section's bold title line, hyperlinked when a link applies:
 * an explicit `title_link` on the section object wins; otherwise a title
 * that looks like the Ben 1:1 prep section ("ben" and "1:1", any case)
 * falls back to the hardcoded Ben 1:1 canvas. Sections with neither render
 * the classic plain bold title.
 *
 * @param {{title: string, title_link?: string}} section
 * @returns {string} mrkdwn
 */
function sectionTitleMrkdwn(section) {
  const title = String(section.title == null ? "" : section.title);
  let link = usableLink(section.title_link);
  if (!link && /\bben\b/i.test(title) && title.includes("1:1")) {
    link = BEN_ONE_ON_ONE_CANVAS_URL;
  }
  return link ? `*<${link}|${title}>*` : `*${title}*`;
}

/**
 * Renders one named section. Consecutive PLAIN items are condensed into one
 * section block (the bold title leads the first such block, exactly as
 * before - an all-plain section still renders as the single classic block).
 * Runs of consecutive CALENDAR items get one compact-lines block per run,
 * each ACTIONABLE item gets its own section block with an accessory button
 * plus a ⏰/✖️ actions row (see buildActionItemBlocks), and each DRAFT item
 * gets its own section block with a "📝 View draft" accessory (see
 * buildDraftItemBlock).
 *
 * @param {{title: string, items: Array<string|object>}} section
 * @param {number} [maxItems] - when set and the section has more items,
 *   only the first `maxItems` are rendered, followed by an
 *   "…and N more" line
 * @returns {Array<object>}
 */
function buildSectionBlocks(section, maxItems) {
  const items = section.items || [];
  const shown = maxItems && items.length > maxItems ? items.slice(0, maxItems) : items;

  const blocks = [];
  let plainLines = [sectionTitleMrkdwn(section)]; // title leads the first plain block
  let calendarLines = null; // open run of consecutive calendar items

  const pushLinesBlock = (lines) => {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(lines.join("\n"), MAX_SECTION_TEXT) },
    });
  };
  const flushPlain = () => {
    if (plainLines.length > 0) {
      pushLinesBlock(plainLines);
      plainLines = [];
    }
  };
  const flushCalendar = () => {
    if (calendarLines) {
      pushLinesBlock(calendarLines);
      calendarLines = null;
    }
  };

  shown.forEach((raw) => {
    if (isActionItem(raw)) {
      flushPlain();
      flushCalendar();
      blocks.push(...buildActionItemBlocks(raw));
    } else if (isDraftItem(raw)) {
      flushPlain();
      flushCalendar();
      blocks.push(buildDraftItemBlock(raw));
    } else if (isCalendarItem(raw)) {
      flushPlain();
      if (!calendarLines) calendarLines = [];
      calendarLines.push(calendarItemMrkdwn(raw));
    } else {
      flushCalendar();
      const item = normalizeItem(raw);
      let line = `• ${itemMrkdwn(item)}`;
      if (item.link) {
        line += `  <${item.link}|open>`;
      }
      plainLines.push(line);
    }
  });

  if (shown.length < items.length) {
    const more = `_…and ${items.length - shown.length} more_`;
    if (calendarLines) calendarLines.push(more);
    else plainLines.push(more);
  }
  flushPlain();
  flushCalendar();

  return blocks;
}

// ---------------------------------------------------------------------------
// Recommendations (re-rankable, "done"-able)
// ---------------------------------------------------------------------------

const RECOMMENDATIONS_TITLE = "Reply-worthy";

/**
 * Stable block_id for the recommendations header. The interactions handler
 * uses this to find where the recommendations sub-list starts inside the
 * original message's blocks, so it can replace everything from here down
 * while preserving the sections above.
 */
const RECS_HEADER_BLOCK_ID = "recs_header";

/**
 * Above this many recommendations, per-item buttons are capped (🔼/🔽 are
 * skipped) to stay under Slack's block/size limits. Non-delegatable items
 * keep just ✅; delegatable items keep ✅ AND 🤖 Do it.
 */
const MAX_ITEMS_WITH_REORDER_BUTTONS = 12;

/**
 * True when a recommendation may be delegated to the bot ("🤖 Do it").
 * Accepts both the caller-facing `delegatable: true` shape and the compact
 * `d: 1` flag that round-trips through button `value` payloads.
 *
 * @param {{delegatable?: boolean, d?: number}} rec
 * @returns {boolean}
 */
function isDelegatable(rec) {
  return !!(rec && (rec.delegatable || rec.d));
}

/**
 * True when a recommendation may be parked for the next 1:1 ("📌 Park for
 * 1:1"). Accepts both the caller-facing `parkable: true` shape and the
 * compact `p: 1` flag that round-trips through button `value` payloads.
 * Defaults to FALSE, so payloads predating the flag render no 📌 button.
 *
 * @param {{parkable?: boolean, p?: number}} rec
 * @returns {boolean}
 */
function isParkable(rec) {
  return !!(rec && (rec.parkable || rec.p));
}

/**
 * True when a recommendation may be delegated to a PERSON (the "🙋 Delegate
 * to..." users_select). Accepts both the caller-facing
 * `delegatable_person: true` shape and the compact `dp: 1` flag that
 * round-trips through button `value` payloads. Defaults to FALSE, so
 * payloads predating the flag render no 🙋 picker.
 *
 * Note this is INDEPENDENT of `delegatable` (🤖 Do it, delegate to the bot):
 * an item can be bot-delegatable, person-delegatable, both, or neither.
 *
 * @param {{delegatable_person?: boolean, dp?: number}} rec
 * @returns {boolean}
 */
function isPersonDelegatable(rec) {
  return !!(rec && (rec.delegatable_person || rec.dp));
}

/**
 * Stable per-recommendation block_id prefix for the section half of each
 * recommendation pair (and for done items). The interactions handler uses
 * these (plus the paired `rec_actions_<id>` 🔗 Open button URLs) to recover
 * each recommendation's link from the original message's blocks whenever the
 * link was dropped from button values (see buildActionValue).
 */
const REC_TEXT_BLOCK_ID_PREFIX = "rec_text_";

/**
 * Longest recommendation id we will build a block_id from. Both prefixes
 * (`rec_text_`, `rec_actions_`) plus a `__<n>` de-duplication suffix have to
 * fit inside Slack's 255-char block_id cap; 230 leaves ample headroom.
 */
const MAX_REC_ID = 230;

/**
 * Returns `recommendations` with a NON-EMPTY, UNIQUE, string `id` on every
 * entry.
 *
 * Every recommendation contributes two block_ids to the message
 * (`rec_text_<id>` and `rec_actions_<id>`), and Slack rejects the whole
 * message with `invalid_blocks` when any two blocks share a block_id. A
 * payload whose recs omit `id` collapsed every row onto
 * `rec_text_undefined` / `rec_actions_undefined`, and repeated ids collided
 * the same way - so a single malformed field made the entire brief
 * unpostable rather than degrading one row.
 *
 * Ids are also what travel in button `value` payloads and what
 * `recoverRecItem` slices back out of a clicked block_id, so normalizing
 * here - once, before both the blocks and the button values are built - is
 * what keeps those two representations agreeing with each other.
 *
 * The mapping is deterministic and idempotent: ids that are already unique
 * and in range are returned untouched, so rebuilding the list from a button
 * value after a 🔼/🔽/✅ click yields exactly the same ids as the original
 * render.
 *
 * @param {Array<object|string>} recommendations
 * @returns {Array<object>} same length and order, every entry with a good id
 */
function withUniqueRecIds(recommendations) {
  const seen = new Set();
  return (recommendations || []).map((rec, index) => {
    const item = rec && typeof rec === "object" ? rec : { text: rec };
    let base = truncateId(item.id);
    if (!base) base = `rec_${index + 1}`;

    let id = base;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${base}__${suffix}`;
      suffix += 1;
    }
    seen.add(id);

    return item.id === id ? item : { ...item, id };
  });
}

/**
 * Coerces a recommendation id to a trimmed string of at most MAX_REC_ID
 * chars, returning "" for anything that cannot yield a usable id (null,
 * undefined, empty/whitespace strings, objects).
 *
 * @param {*} rawId
 * @returns {string}
 */
function truncateId(rawId) {
  if (rawId == null) return "";
  if (typeof rawId === "object") return "";
  return String(rawId).trim().slice(0, MAX_REC_ID);
}

/**
 * Above this total value length, links are dropped from stored items (see
 * buildActionValue). Kept comfortably below MAX_BUTTON_VALUE so JSON-escaping
 * overhead can never push the final string past Slack's hard cap.
 */
const STORED_LINKS_SOFT_MAX = 1900;

/**
 * Strips a recommendation down to the {id, text, done} shape that travels
 * in button `value` payloads, plus a compact `d: 1` flag when the item is
 * delegatable (omitted otherwise, to save value bytes) and `delegated: true`
 * once it has been queued via 🤖 Do it. Links ARE included when `withLinks`
 * is true (so rebuilt rows keep their 🔗 Open button even when the original
 * blocks can't be consulted); buildActionValue drops them wholesale (never
 * truncated - a cut URL is useless) when the total payload would approach
 * Slack's 2000-char cap on button values, which Slack rejects with
 * invalid_blocks. The interactions handler ALSO recovers links from the
 * original message blocks (via extractRecLinks) as a fallback, so a dropped
 * link only degrades rows rebuilt without access to the original message.
 *
 * @param {{id: string, text: string, link?: string, done?: boolean, delegatable?: boolean, delegated?: boolean}} rec
 * @param {number} textCap - max stored text length
 * @param {boolean} withLinks - include `link` in the stored shape
 */
function toStoredItem(rec, textCap, withLinks) {
  const stored = { id: rec.id, text: truncate(String(rec.text == null ? "" : rec.text), textCap), done: !!rec.done };
  if (withLinks && typeof rec.link === "string" && rec.link) stored.link = rec.link;
  if (isDelegatable(rec)) stored.d = 1;
  // `p` / `dp` mirror `d`: without them the 📌/🙋 extras would silently
  // disappear from every row the first time any 🔼/🔽/✅ click rebuilds the
  // list from a button value. Omitted when false, to save value bytes.
  if (isParkable(rec)) stored.p = 1;
  if (isPersonDelegatable(rec)) stored.dp = 1;
  if (rec.delegated) stored.delegated = true;
  // `due` (short, optional) rides along so the ⏰ Snooze button keeps the
  // item's due date across 🔼/🔽/✅ rebuilds.
  if (typeof rec.due === "string" && rec.due) {
    stored.due = truncate(rec.due, SEC_ITEM_VALUE_DUE_MAX);
  }
  return stored;
}

/**
 * Builds the JSON `value` string carried by every 🔼/🔽/✅ button, keeping
 * it under Slack's 2000-char button-value limit. Links are included while
 * the whole payload fits under STORED_LINKS_SOFT_MAX; past that, the LONGEST
 * stored link is dropped (whole, never truncated - a cut URL is useless),
 * repeating until the payload fits, so one pathological URL costs only
 * itself. If the value still overflows with every link gone, the per-item
 * stored-text cap is progressively shrunk until it fits, exactly as before.
 *
 * @param {Array<object>} allRecommendations - full ordered list
 * @param {string} actedId
 * @returns {string}
 */
function buildActionValue(allRecommendations, actedId) {
  let cap = 150;
  const items = allRecommendations.map((rec) => toStoredItem(rec, cap, true));
  let value = JSON.stringify({ items, actedId });

  while (value.length > STORED_LINKS_SOFT_MAX) {
    let longest = -1;
    items.forEach((item, index) => {
      if (
        typeof item.link === "string" &&
        (longest === -1 || item.link.length > items[longest].link.length)
      ) {
        longest = index;
      }
    });
    if (longest === -1) break; // no links left to drop
    delete items[longest].link;
    value = JSON.stringify({ items, actedId });
  }

  while (value.length > MAX_BUTTON_VALUE && cap > 10) {
    cap = Math.floor(cap / 2);
    value = JSON.stringify({
      items: allRecommendations.map((rec) => toStoredItem(rec, cap, false)),
      actedId,
    });
  }
  return value;
}

/**
 * Builds the section block for a DONE recommendation: "✅ " prefix,
 * strikethrough text, and NO actions block (done items get no buttons).
 * A link accessory, if present, is kept - it's client-side only.
 *
 * @param {{text: string, link?: string, flag?: string}} rec
 * @returns {object} Slack Block Kit `section` block
 */
function buildDoneItemBlock(rec) {
  const rendered = buildItemSectionBlock(rec);
  let text = `✅ ~${rec.text}~`;
  if (rec.flag) {
    text += `  •  _${rec.flag}_`;
  }
  rendered.text.text = truncate(text, MAX_SECTION_TEXT);
  rendered.block_id = `${REC_TEXT_BLOCK_ID_PREFIX}${rec.id}`;
  return rendered;
}

/**
 * Builds the section block for a DELEGATED recommendation (🤖 Do it was
 * clicked): "🤖 _queued: text_", and NO actions block (🔼/🔽/✅/🤖 are all
 * removed). The item stays where it was in the list - it is neither done
 * nor sorted last. A link accessory, if present, is kept - it's client-side
 * only, and it lets the interactions handler keep recovering the link.
 *
 * @param {{id: string, text: string, link?: string, flag?: string}} rec
 * @returns {object} Slack Block Kit `section` block
 */
function buildDelegatedItemBlock(rec) {
  const rendered = buildItemSectionBlock(rec);
  let text = `🤖 _queued: ${rec.text}_`;
  if (rec.flag) {
    text += `  •  _${rec.flag}_`;
  }
  rendered.text.text = truncate(text, MAX_SECTION_TEXT);
  rendered.block_id = `${REC_TEXT_BLOCK_ID_PREFIX}${rec.id}`;
  return rendered;
}

/**
 * Builds the section+actions block pair for one NOT-done, NOT-delegated
 * recommendation.
 *
 * @param {Array<object>} allRecommendations - full ordered list (for the button value)
 * @param {object} recommendation - the one this pair renders
 * @param {number} rank - 1-based rank among NOT-done items only
 * @param {boolean} compact - when true, 🔼/🔽 are skipped (list is large;
 *   stay under Slack block limits): non-delegatable items keep just ✅,
 *   delegatable items keep ✅ and 🤖 Do it. The conditional 📌 / 🙋 extras
 *   are independent of `compact` - they follow the rec's `parkable` /
 *   `delegatable_person` flags either way.
 * @returns {Array<object>} [section block, actions block]
 */
function buildRecommendationPairBlocks(allRecommendations, recommendation, rank, compact) {
  const value = buildActionValue(allRecommendations, recommendation.id);

  const button = (actionId, label) => ({
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label, emoji: true },
    value,
  });

  const sectionBlock = buildItemSectionBlock(recommendation);
  sectionBlock.text.text = truncate(`*${rank}.* ${sectionBlock.text.text}`, MAX_SECTION_TEXT);
  sectionBlock.block_id = `${REC_TEXT_BLOCK_ID_PREFIX}${recommendation.id}`;

  const elements = compact
    ? [button("item_done", "✅")]
    : [button("item_up", "🔼"), button("item_down", "🔽"), button("item_done", "✅")];

  // "🔗 Open" (action_id `item_open__<id>`): a LINK button, FIRST in the row,
  // shown when the recommendation carries a link. Slack opens the URL
  // client-side but still fires a block_actions event - the interactions
  // handler treats any `item_open*` action_id as an acked no-op. It replaces
  // the old right-aligned section accessory (dropped just below) so the row
  // shows exactly one Open affordance; done/delegated rows, which have no
  // actions block, keep the accessory instead. The interactions handler
  // recovers links from this button's `url` (or the legacy accessory) via
  // extractRecLinks. Rendered ONLY when the item's own link is usable
  // (non-empty http(s), within Slack's 3000-char button-url cap) - there is
  // NO fallback URL: an item without a usable link gets NO Open button.
  if (usableLink(recommendation.link)) {
    elements.unshift({
      type: "button",
      action_id: `item_open__${recommendation.id}`,
      text: { type: "plain_text", text: "🔗 Open", emoji: true },
      url: recommendation.link,
    });
  }
  delete sectionBlock.accessory;
  if (isDelegatable(recommendation)) {
    elements.push(button("item_delegate", "🤖 Do it"));
  }

  // "📌 Park for 1:1" (action_id `item_park`): parks the item for the next
  // 1:1 - the interactions handler queues a "park" delegation entry, appends
  // "→ 📌 parked for next 1:1" to the item's text, and removes this actions
  // row. The value is a static marker (NOT the {items, actedId} payload) -
  // the handler recovers the item's text from the sibling buttons' values
  // and its link from the rec_text_<id> accessory URL.
  // Rendered ONLY for items flagged `parkable: true` (default false).
  if (isParkable(recommendation)) {
    elements.push({
      type: "button",
      action_id: "item_park",
      text: { type: "plain_text", text: "📌 Park for 1:1", emoji: true },
      value: '{"type":"park"}',
    });
  }

  // "⏰ Snooze" (action_id `item_snooze`) and "✖️ Not for me" (action_id
  // `item_dismiss`): the interactions handler queues a "snooze" / "dismiss"
  // delegation entry (text/link recovered exactly like 📌 Park), marks the
  // item in place and removes this actions row. Like 📌, the values are
  // static markers, not the {items, actedId} payload - the snooze marker
  // additionally carries the item's `due` date when the payload set one.
  elements.push({
    type: "button",
    action_id: "item_snooze",
    text: { type: "plain_text", text: "⏰ Snooze", emoji: true },
    value: JSON.stringify(
      typeof recommendation.due === "string" && recommendation.due
        ? { type: "snooze", due: truncate(recommendation.due, SEC_ITEM_VALUE_DUE_MAX) }
        : { type: "snooze" }
    ),
  });
  elements.push({
    type: "button",
    action_id: "item_dismiss",
    text: { type: "plain_text", text: "✖️ Not for me", emoji: true },
    value: '{"type":"dismiss"}',
  });

  // "🙋 Delegate to..." user picker (action_id `item_delegate_person`):
  // selecting a person queues a "delegated_to" delegation entry. It carries
  // no value - Slack sends selected_user plus the block context, and the
  // interactions handler recovers the item's text/link from the sibling
  // buttons' values / the rec_text_<id> accessory URL. Row element count
  // stays at most 8 (🔼🔽✅🤖📌⏰✖️ + this), well under Slack's 25-element
  // cap on actions blocks.
  // Rendered ONLY for items flagged `delegatable_person: true` (default
  // false).
  if (isPersonDelegatable(recommendation)) {
    elements.push({
      type: "users_select",
      action_id: "item_delegate_person",
      placeholder: { type: "plain_text", text: "🙋 Delegate to...", emoji: true },
    });
  }

  // Defence in depth: an `actions` block with zero elements - or holding a
  // `false`/`undefined` entry left behind by a conditional push - is rejected
  // by Slack with `invalid_blocks`, taking the WHOLE message down rather than
  // just that row. Drop anything malformed, and emit no actions block at all
  // when nothing survives (a lone section block is perfectly legal).
  const safeElements = elements.filter(isValidActionElement).slice(0, MAX_ACTIONS_ELEMENTS);

  if (safeElements.length === 0) {
    return [sectionBlock];
  }

  return [
    sectionBlock,
    {
      type: "actions",
      // Not truncated: withUniqueRecIds already caps ids at MAX_REC_ID so
      // that prefix + id stays inside MAX_BLOCK_ID. Trimming here would
      // append an ellipsis and break recoverRecItem's block_id -> id slice.
      block_id: `rec_actions_${recommendation.id}`,
      elements: safeElements,
    },
  ];
}

/**
 * True when `element` is a structurally valid `actions` block element: a
 * real object carrying a `type` and an `action_id`, with the per-type
 * requirements Slack enforces (buttons need non-empty text plus either a
 * `url` or a non-empty `value` within the 2000-char cap; selects need a
 * non-empty placeholder).
 *
 * @param {*} element
 * @returns {boolean}
 */
function isValidActionElement(element) {
  if (!element || typeof element !== "object") return false;
  if (!element.type || !element.action_id) return false;

  if (element.type === "button") {
    if (!element.text || !element.text.text) return false;
    if (typeof element.value === "string" && element.value.length > MAX_BUTTON_VALUE) return false;
    if (!element.url && !element.value) return false;
  }

  if (element.type.endsWith("_select") && !(element.placeholder && element.placeholder.text)) {
    return false;
  }

  return true;
}

/**
 * Builds the full recommendations sub-list: bold header (with the stable
 * `recs_header` block_id) + blocks per recommendation, in order. NOT-done
 * items get a rank number (counting non-done items only) and a
 * section+actions pair; done items render as a single section block with
 * "✅ " + strikethrough text and no buttons. Used both by the initial
 * /render-brief message and to rebuild just this sub-list after a button
 * click, so sizes stay consistent between the two paths.
 *
 * @param {Array<{id: string, text: string, link?: string, done?: boolean}>} recommendations
 * @returns {Array<object>}
 */
function buildRecommendationsBlocks(recommendations) {
  // Normalize ids ONCE, up front: every downstream consumer (block_ids,
  // button values, applyAction's id lookup) reads from this same array, so
  // they cannot disagree about what a given row's id is.
  const items = withUniqueRecIds(recommendations);
  const titleBlock = buildTitleBlock(RECOMMENDATIONS_TITLE);
  titleBlock.block_id = RECS_HEADER_BLOCK_ID;
  const blocks = [titleBlock];

  if (items.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Nothing left here - all caught up_ ✅" },
    });
    return blocks;
  }

  const compact = items.length > MAX_ITEMS_WITH_REORDER_BUTTONS;

  let rank = 0;
  items.forEach((rec) => {
    if (rec.done) {
      blocks.push(buildDoneItemBlock(rec));
    } else if (rec.delegated) {
      blocks.push(buildDelegatedItemBlock(rec));
    } else {
      rank += 1;
      blocks.push(...buildRecommendationPairBlocks(items, rec, rank, compact));
    }
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Voice briefing link button
// ---------------------------------------------------------------------------

const DEFAULT_VOICE_PROJECT_URL =
  "https://claude.ai/project/01a016ef-9b3a-757d-bb5b-7c13adf52973";

/**
 * Builds an `actions` block holding two buttons in one row:
 *   - "🎙️ Hear it" (action_id `voice_open`): a LINK button pointing at the
 *     voice-briefing project. Link buttons are handled client-side by Slack
 *     (the URL just opens), but Slack still fires a block_actions event for
 *     them - the interactions handler acks `voice_open` with an empty 200
 *     and does nothing else.
 *   - "🔄 Refresh brief" (action_id `brief_refresh`): a REGULAR action
 *     button (no url). The interactions handler queues a "refresh"
 *     delegation entry and swaps this button's text/action_id in place so
 *     it can't be queued twice from the same message.
 *
 * The voice URL comes from VOICE_PROJECT_URL (read at build time so tests
 * can override it), falling back to the default project URL.
 *
 * Both buttons share ONE actions block (block_id `voice_actions`), so this
 * still costs a single block against the ≤45/50-block message guards and
 * the 100-block Home cap.
 *
 * @returns {object} Slack Block Kit `actions` block
 */
function buildVoiceButtonBlock() {
  return {
    type: "actions",
    block_id: "voice_actions",
    elements: [
      {
        type: "button",
        action_id: "voice_open",
        text: { type: "plain_text", text: "🎙️ Hear it", emoji: true },
        url: process.env.VOICE_PROJECT_URL || DEFAULT_VOICE_PROJECT_URL,
      },
      {
        type: "button",
        action_id: "brief_refresh",
        text: { type: "plain_text", text: "🔄 Refresh brief", emoji: true },
        value: '{"type":"refresh"}',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Full message assembly
// ---------------------------------------------------------------------------

/**
 * "View all in Home" footer link target. Slack strips non-http(s) schemes
 * from mrkdwn links and doesn't document slack:// for button `url`s, so the
 * https app_redirect URL is used instead - Slack redirects it into this
 * app's Home in the client. Overridable via HOME_TAB_URL (read at build time
 * so tests can override it).
 */
const DEFAULT_HOME_TAB_URL =
  "https://slack.com/app_redirect?app=A0BR53L1GE4&team=T07MV6787FY";

/**
 * Footer context block closing every brief: a "📊 View all in Home" link
 * pointing at the app's Home tab (rendered as an mrkdwn link in a context
 * block - no interactivity, Slack handles the redirect client-side).
 *
 * @returns {object} Slack Block Kit `context` block
 */
function buildHomeFooterBlock() {
  const url = process.env.HOME_TAB_URL || DEFAULT_HOME_TAB_URL;
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${url}|📊 View all in Home>` }],
  };
}

/**
 * @param {object} payload
 * @param {string} [payload.priority_recap]
 * @param {Array<{title: string, items: Array<object>}>} [payload.sections]
 * @param {Array<{id: string, text: string, link?: string}>} [payload.recommendations]
 * @param {string} [payload.title] - custom header title (default "Morning Brief")
 * @param {string} [payload.emoji] - custom header emoji prefix
 * @param {Date} [date] - override for testing
 * @returns {Array<object>} full Block Kit `blocks` array
 */
function buildBriefBlocks({ priority_recap, sections, recommendations, title, emoji } = {}, date) {
  const assemble = (sectionList, recs, maxItemsPerSection) => {
    const blocks = [buildHeaderBlock(date, title, emoji)];

    if (priority_recap) {
      blocks.push(buildPriorityRecapBlock(truncate(String(priority_recap), MAX_SECTION_TEXT - 4)));
    }

    // Voice-briefing link button, right after the header/recap and before the
    // sections. Built inside assemble() so it counts toward the ≤45-block
    // guard below like every other block.
    blocks.push(buildVoiceButtonBlock());

    sectionList.forEach((section, index) => {
      blocks.push(...buildSectionBlocks(section, maxItemsPerSection));
      if (index < sectionList.length - 1) {
        blocks.push({ type: "divider" });
      }
    });

    if (recs && recs.length > 0) {
      if (sectionList.length > 0) {
        blocks.push({ type: "divider" });
      }
      blocks.push(...buildRecommendationsBlocks(recs));
    }

    // Footer: "View all in Home" link. Built inside assemble() so it counts
    // toward the ≤45-block guard below like every other block.
    blocks.push(buildHomeFooterBlock());

    return blocks;
  };

  const sectionList = sections || [];
  let recs = recommendations || [];
  let maxItemsPerSection; // undefined = no per-section item cap
  let blocks = assemble(sectionList, recs, maxItemsPerSection);

  // Hard guard: never send a payload that could exceed Slack's 50-block cap.
  // Shed lowest-priority content first: extra section items beyond 3 per
  // section (an "…and N more" line is appended), then recommendations
  // beyond 8, then (last resort) further recommendations from the tail.
  if (blocks.length > SOFT_MAX_BLOCKS) {
    maxItemsPerSection = 3;
    blocks = assemble(sectionList, recs, maxItemsPerSection);
  }
  if (blocks.length > SOFT_MAX_BLOCKS && recs.length > 8) {
    recs = recs.slice(0, 8);
    blocks = assemble(sectionList, recs, maxItemsPerSection);
  }
  while (blocks.length > SOFT_MAX_BLOCKS && recs.length > 0) {
    recs = recs.slice(0, recs.length - 1);
    blocks = assemble(sectionList, recs, maxItemsPerSection);
  }
  // Absolute backstop (pathological inputs, e.g. dozens of sections):
  // dropping trailing blocks keeps the message valid — a trailing section
  // without its actions block is still legal Block Kit.
  while (blocks.length > SLACK_MAX_BLOCKS) {
    blocks.pop();
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Stateless up / down / done logic
// ---------------------------------------------------------------------------

/**
 * Stable partition: NOT-done items first (in their current relative order),
 * done items after (in their current relative order).
 *
 * @param {Array<{done?: boolean}>} items
 * @returns {Array<object>}
 */
function sortDoneLast(items) {
  return [...items.filter((i) => !i.done), ...items.filter((i) => i.done)];
}

/**
 * Applies a button action to the recommendations array, returning a NEW
 * array (does not mutate the input).
 *
 * - item_done: marks the item done (it is NOT removed; it renders with
 *   strikethrough and no buttons, and sorts to the bottom).
 * - item_delegate: marks the item delegated (it is NOT removed, NOT done,
 *   and NOT sorted last - it stays in place, rendered as "🤖 _queued: …_"
 *   with all buttons removed).
 * - item_up / item_down: swaps the item with its previous/next NOT-done,
 *   NOT-delegated neighbor. No-ops at the boundaries, and no-ops for
 *   done/delegated items (they have no buttons anyway).
 *
 * The returned array is always re-partitioned so done items sit at the
 * bottom, preserving relative order within each group (delegated items are
 * NOT done, so they keep their position among the not-done items).
 *
 * @param {Array<{id: string, done?: boolean, delegated?: boolean}>} items
 * @param {string} actedId
 * @param {"item_up"|"item_down"|"item_done"|"item_delegate"} actionId
 * @returns {Array<object>} the new items array
 */
function applyAction(items, actedId, actionId) {
  const next = items.map((item) => ({ ...item, done: !!item.done }));
  const index = next.findIndex((item) => item.id === actedId);

  if (index === -1) {
    // Acted item no longer present (shouldn't normally happen) - no-op.
    return sortDoneLast(next);
  }

  if (actionId === "item_done") {
    next[index].done = true;
  } else if (actionId === "item_delegate") {
    if (!next[index].done) {
      next[index].delegated = true;
    }
  } else if (
    (actionId === "item_up" || actionId === "item_down") &&
    !next[index].done &&
    !next[index].delegated
  ) {
    const dir = actionId === "item_up" ? -1 : 1;
    // Find the nearest NOT-done, NOT-delegated neighbor in the given
    // direction (delegated items stay in place).
    let j = index + dir;
    while (j >= 0 && j < next.length && (next[j].done || next[j].delegated)) {
      j += dir;
    }
    if (j >= 0 && j < next.length) {
      [next[index], next[j]] = [next[j], next[index]];
    }
  }

  return sortDoneLast(next);
}

module.exports = {
  buildHeaderBlock,
  buildPriorityRecapBlock,
  buildItemSectionBlock,
  buildTitleBlock,
  buildSectionBlocks,
  buildVoiceButtonBlock,
  buildRecommendationsBlocks,
  buildBriefBlocks,
  applyAction,
  RECOMMENDATIONS_TITLE,
  RECS_HEADER_BLOCK_ID,
  REC_TEXT_BLOCK_ID_PREFIX,
  SEC_ITEM_BLOCK_ID_PREFIX,
  SEC_ITEM_ACTIONS_BLOCK_ID_PREFIX,
  MAX_ITEMS_WITH_REORDER_BUTTONS,
};
