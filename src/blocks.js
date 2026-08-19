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
 *      the bold title on the first line, then one "• item" line per item
 *      (flag as an italic suffix, link as an inline `<url|open>` mrkdwn
 *      link) - keeping the whole message well under Slack's hard cap of 50
 *      blocks per message. Two further item shapes exist:
 *        - ACTIONABLE items ({text, link?, id, action: {type, ...}}) render
 *          as their own section block (text hyperlinked to `link` when
 *          present) with an accessory button: action.type "archive_email" →
 *          "🗑️ Archive" (action_id `sec_item_archive`), "done" → "✅ Done"
 *          (action_id `sec_item_done`). The button value is a compact JSON
 *          {id, type, gmail_thread_id?, text (truncated), link?}.
 *        - CALENDAR items ({time, title, link?, note?}, no action) render as
 *          compact "`8:00–9:00`  *<link|Title>* — note" lines, one section
 *          block per run of consecutive calendar items (no per-item blocks
 *          or dividers).
 *      A divider is inserted between each named section.
 *   4. (optional) recommendations: a bold "Reply-worthy" header, then one
 *      section+actions block pair per recommendation. The section half is
 *      built like a plain item (text + optional link accessory) and carries
 *      a stable `rec_text_<id>` block_id. The actions half carries three
 *      buttons - 🔼 (item_up), 🔽 (item_down), ✅ (item_done) - plus a
 *      fourth "🤖 Do it" button (item_delegate) when the recommendation is
 *      marked `delegatable: true`, a "📌 Park for 1:1" button (item_park,
 *      static value), and a "🙋 Delegate to..." users_select
 *      (item_delegate_person, no value). Button `value` is a JSON string of
 *      `{ items: [...all current recommendations, in order...], actedId }`,
 *      so the whole ordered list travels with every click. No DB, no
 *      server-side state. To stay under Slack's 2000-char limit on button
 *      values, stored items carry only {id, text (truncated), done}, plus
 *      `d:1` when delegatable and `delegated:true` once delegated - links
 *      are NOT stored; the interactions handler recovers them from the
 *      original message's `rec_text_<id>` accessory URLs.
 *
 *      Delegated items (🤖 Do it was clicked) stay in place - not done, not
 *      sorted last - rendered as "🤖 _queued: text_" with ALL buttons
 *      removed.
 */

// Slack hard limits we render against.
const SLACK_MAX_BLOCKS = 50;
const SOFT_MAX_BLOCKS = 45; // our own guard threshold, comfortably below 50
const MAX_SECTION_TEXT = 2990; // Slack section text cap is 3000 chars
const MAX_BUTTON_VALUE = 2000; // Slack button `value` cap

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

  if (item.link) {
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

/** Stable block_id prefix for actionable section-item blocks. */
const SEC_ITEM_BLOCK_ID_PREFIX = "sec_item_";

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
 * Builds the section block for one ACTIONABLE item: mrkdwn text (hyperlinked
 * to `item.link` when present) with an accessory 🗑️ Archive / ✅ Done button.
 * The button value is a compact JSON {id, type, gmail_thread_id?, text
 * (truncated), link?}; the link is dropped from the value (never truncated -
 * a cut URL is useless) if it would push the JSON near Slack's 2000-char cap.
 *
 * @param {{text: string, link?: string, id?: string, action: {type: string, gmail_thread_id?: string}}} item
 * @returns {object} Slack Block Kit `section` block
 */
function buildActionItemBlock(item) {
  const config = SEC_ITEM_BUTTONS[item.action.type];
  const text = String(item.text == null ? "" : item.text);

  const value = { id: item.id, type: item.action.type };
  if (typeof item.action.gmail_thread_id === "string") {
    value.gmail_thread_id = item.action.gmail_thread_id;
  }
  value.text = truncate(text, SEC_ITEM_VALUE_TEXT_MAX);
  if (typeof item.link === "string") value.link = item.link;
  let valueJson = JSON.stringify(value);
  if (valueJson.length > SEC_ITEM_VALUE_SOFT_MAX) {
    delete value.link;
    valueJson = JSON.stringify(value);
  }

  const mrkdwn = typeof item.link === "string" ? `<${item.link}|${text}>` : text;

  return {
    type: "section",
    block_id: `${SEC_ITEM_BLOCK_ID_PREFIX}${item.id}`,
    text: { type: "mrkdwn", text: truncate(mrkdwn, MAX_SECTION_TEXT) },
    accessory: {
      type: "button",
      action_id: config.action_id,
      text: { type: "plain_text", text: config.label, emoji: true },
      value: valueJson,
    },
  };
}

/**
 * Renders one named section. Consecutive PLAIN items are condensed into one
 * section block (the bold title leads the first such block, exactly as
 * before - an all-plain section still renders as the single classic block).
 * Runs of consecutive CALENDAR items get one compact-lines block per run,
 * and each ACTIONABLE item gets its own section block with an accessory
 * button (see buildActionItemBlock).
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
  let plainLines = [`*${section.title}*`]; // title leads the first plain block
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
      blocks.push(buildActionItemBlock(raw));
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
 * Stable per-recommendation block_id prefix for the section half of each
 * recommendation pair (and for done items). The interactions handler uses
 * these to recover each recommendation's link (its accessory URL) from the
 * original message's blocks, since links are deliberately NOT stored in
 * button values (see buildActionValue).
 */
const REC_TEXT_BLOCK_ID_PREFIX = "rec_text_";

/**
 * Strips a recommendation down to the {id, text, done} shape that travels
 * in button `value` payloads, plus a compact `d: 1` flag when the item is
 * delegatable (omitted otherwise, to save value bytes) and `delegated: true`
 * once it has been queued via 🤖 Do it. Links are intentionally NOT
 * included: with long URLs (e.g. Google Calendar deep links) they blow past
 * Slack's 2000-char cap on button values, which Slack rejects with
 * invalid_blocks. The interactions handler recovers links from the original
 * message blocks instead (via REC_TEXT_BLOCK_ID_PREFIX block_ids).
 *
 * @param {{id: string, text: string, done?: boolean, delegatable?: boolean, delegated?: boolean}} rec
 * @param {number} textCap - max stored text length
 */
function toStoredItem(rec, textCap) {
  const stored = { id: rec.id, text: truncate(String(rec.text == null ? "" : rec.text), textCap), done: !!rec.done };
  if (isDelegatable(rec)) stored.d = 1;
  if (rec.delegated) stored.delegated = true;
  return stored;
}

/**
 * Builds the JSON `value` string carried by every 🔼/🔽/✅ button, keeping
 * it under Slack's 2000-char button-value limit by progressively shrinking
 * the per-item stored-text cap until it fits.
 *
 * @param {Array<object>} allRecommendations - full ordered list
 * @param {string} actedId
 * @returns {string}
 */
function buildActionValue(allRecommendations, actedId) {
  let cap = 150;
  let value = JSON.stringify({
    items: allRecommendations.map((rec) => toStoredItem(rec, cap)),
    actedId,
  });
  while (value.length > MAX_BUTTON_VALUE && cap > 10) {
    cap = Math.floor(cap / 2);
    value = JSON.stringify({
      items: allRecommendations.map((rec) => toStoredItem(rec, cap)),
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
 *   delegatable items keep ✅ and 🤖 Do it
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
  if (isDelegatable(recommendation)) {
    elements.push(button("item_delegate", "🤖 Do it"));
  }

  // "📌 Park for 1:1" (action_id `item_park`): parks the item for the next
  // 1:1 - the interactions handler queues a "park" delegation entry, appends
  // "→ 📌 parked for next 1:1" to the item's text, and removes this actions
  // row. The value is a static marker (NOT the {items, actedId} payload) -
  // the handler recovers the item's text from the sibling buttons' values
  // and its link from the rec_text_<id> accessory URL.
  elements.push({
    type: "button",
    action_id: "item_park",
    text: { type: "plain_text", text: "📌 Park for 1:1", emoji: true },
    value: '{"type":"park"}',
  });

  // "🙋 Delegate to..." user picker (action_id `item_delegate_person`):
  // selecting a person queues a "delegated_to" delegation entry. It carries
  // no value - Slack sends selected_user plus the block context, and the
  // interactions handler recovers the item's text/link from the sibling
  // buttons' values / the rec_text_<id> accessory URL. Row element count
  // stays at most 6 (🔼🔽✅🤖📌 + this), well under Slack's 25-element cap
  // on actions blocks.
  elements.push({
    type: "users_select",
    action_id: "item_delegate_person",
    placeholder: { type: "plain_text", text: "🙋 Delegate to...", emoji: true },
  });

  return [
    sectionBlock,
    {
      type: "actions",
      block_id: `rec_actions_${recommendation.id}`,
      elements,
    },
  ];
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
  const items = recommendations || [];
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
  MAX_ITEMS_WITH_REORDER_BUTTONS,
};
