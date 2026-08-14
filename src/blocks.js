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
 *   3. for each entry in `sections`: a bold section-title line, then one
 *      section block per item (item.text as markdown; if item.link is set,
 *      it's attached as a `button`-type accessory that deep-links out via
 *      `url` - Slack opens these directly, no interactivity round-trip, so
 *      they work even while this server is cold/asleep). A divider is
 *      inserted between each named section.
 *   4. (optional) recommendations: a bold "Reply-worthy" header, then one
 *      section+actions block pair per recommendation. The section half is
 *      built the same way as a plain item (text + optional link accessory).
 *      The actions half carries three buttons - 🔼 (item_up), 🔽
 *      (item_down), ✅ (item_done) - whose `value` is a JSON string of
 *      `{ items: [...all current recommendations, in order...], actedId }`,
 *      so the whole ordered list travels with every click. No DB, no
 *      server-side state.
 */

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
  let text = item.text;
  if (item.flag) {
    text += `  •  _${item.flag}_`;
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
  const block = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: itemMrkdwn(item),
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

/**
 * Date-stamped header block, e.g. "☀️ Morning Brief — Friday, August 14".
 *
 * @param {Date} [date]
 * @returns {object} Slack Block Kit `header` block
 */
function buildHeaderBlock(date = new Date()) {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return {
    type: "header",
    text: {
      type: "plain_text",
      text: `☀️ Morning Brief — ${dateStr}`,
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

/**
 * @param {{title: string, items: Array<object>}} section
 * @returns {Array<object>} blocks: title block + one block per item
 */
function buildSectionBlocks(section) {
  const blocks = [buildTitleBlock(section.title)];
  (section.items || []).forEach((item) => {
    blocks.push(buildItemSectionBlock(item));
  });
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
 * Above this many recommendations, per-item buttons are capped to just ✅
 * (🔼/🔽 are skipped) to stay under Slack's block/size limits.
 */
const MAX_ITEMS_WITH_REORDER_BUTTONS = 12;

/**
 * Strips a recommendation down to the {id, text, link, done} shape that
 * travels in button `value` payloads (drops any extra fields callers may
 * have set).
 *
 * @param {{id: string, text: string, link?: string, done?: boolean}} rec
 */
function toStoredItem(rec) {
  const stored = { id: rec.id, text: rec.text, done: !!rec.done };
  if (rec.link) stored.link = rec.link;
  return stored;
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
  rendered.text.text = text;
  return rendered;
}

/**
 * Builds the section+actions block pair for one NOT-done recommendation.
 *
 * @param {Array<object>} allRecommendations - full ordered list (for the button value)
 * @param {object} recommendation - the one this pair renders
 * @param {number} rank - 1-based rank among NOT-done items only
 * @param {boolean} compact - when true, only the ✅ button is emitted
 *   (list is large; skip 🔼/🔽 to stay under Slack block limits)
 * @returns {Array<object>} [section block, actions block]
 */
function buildRecommendationPairBlocks(allRecommendations, recommendation, rank, compact) {
  const value = JSON.stringify({
    items: allRecommendations.map(toStoredItem),
    actedId: recommendation.id,
  });

  const button = (actionId, emoji) => ({
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: emoji, emoji: true },
    value,
  });

  const sectionBlock = buildItemSectionBlock(recommendation);
  sectionBlock.text.text = `*${rank}.* ${sectionBlock.text.text}`;

  const elements = compact
    ? [button("item_done", "✅")]
    : [button("item_up", "🔼"), button("item_down", "🔽"), button("item_done", "✅")];

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
    } else {
      rank += 1;
      blocks.push(...buildRecommendationPairBlocks(items, rec, rank, compact));
    }
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Full message assembly
// ---------------------------------------------------------------------------

/**
 * @param {object} payload
 * @param {string} [payload.priority_recap]
 * @param {Array<{title: string, items: Array<object>}>} [payload.sections]
 * @param {Array<{id: string, text: string, link?: string}>} [payload.recommendations]
 * @param {Date} [date] - override for testing
 * @returns {Array<object>} full Block Kit `blocks` array
 */
function buildBriefBlocks({ priority_recap, sections, recommendations } = {}, date) {
  const blocks = [buildHeaderBlock(date)];

  if (priority_recap) {
    blocks.push(buildPriorityRecapBlock(priority_recap));
  }

  const sectionList = sections || [];
  sectionList.forEach((section, index) => {
    blocks.push(...buildSectionBlocks(section));
    if (index < sectionList.length - 1) {
      blocks.push({ type: "divider" });
    }
  });

  if (recommendations && recommendations.length > 0) {
    if (sectionList.length > 0) {
      blocks.push({ type: "divider" });
    }
    blocks.push(...buildRecommendationsBlocks(recommendations));
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
 * - item_up / item_down: swaps the item with its previous/next NOT-done
 *   neighbor. No-ops at the boundaries, and no-ops for done items.
 *
 * The returned array is always re-partitioned so done items sit at the
 * bottom, preserving relative order within each group.
 *
 * @param {Array<{id: string, done?: boolean}>} items
 * @param {string} actedId
 * @param {"item_up"|"item_down"|"item_done"} actionId
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
  } else if ((actionId === "item_up" || actionId === "item_down") && !next[index].done) {
    const dir = actionId === "item_up" ? -1 : 1;
    // Find the nearest NOT-done neighbor in the given direction.
    let j = index + dir;
    while (j >= 0 && j < next.length && next[j].done) {
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
  buildRecommendationsBlocks,
  buildBriefBlocks,
  applyAction,
  RECOMMENDATIONS_TITLE,
  RECS_HEADER_BLOCK_ID,
  MAX_ITEMS_WITH_REORDER_BUTTONS,
};
