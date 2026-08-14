"use strict";

/**
 * Block Kit builders for the Chief of Staff "Morning Brief" message, plus
 * the stateless up/down/done logic used to re-rank/remove recommendations.
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
 * Strips a recommendation down to the {id, text, link} shape that travels in
 * button `value` payloads (drops any extra fields callers may have set).
 *
 * @param {{id: string, text: string, link?: string}} rec
 */
function toStoredItem(rec) {
  const stored = { id: rec.id, text: rec.text };
  if (rec.link) stored.link = rec.link;
  return stored;
}

/**
 * Builds the section+actions block pair for one recommendation.
 *
 * @param {Array<object>} allRecommendations - full ordered list (for the button value)
 * @param {object} recommendation - the one this pair renders
 * @returns {Array<object>} [section block, actions block]
 */
function buildRecommendationPairBlocks(allRecommendations, recommendation) {
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

  return [
    buildItemSectionBlock(recommendation),
    {
      type: "actions",
      block_id: `rec_actions_${recommendation.id}`,
      elements: [
        button("item_up", "🔼"),
        button("item_down", "🔽"),
        button("item_done", "✅"),
      ],
    },
  ];
}

/**
 * Builds the full recommendations sub-list: bold header + one section+actions
 * pair per recommendation, in order. Used both by the initial /render-brief
 * message and to rebuild just this sub-list after a button click.
 *
 * @param {Array<{id: string, text: string, link?: string}>} recommendations
 * @returns {Array<object>}
 */
function buildRecommendationsBlocks(recommendations) {
  const items = recommendations || [];
  const blocks = [buildTitleBlock(RECOMMENDATIONS_TITLE)];

  if (items.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Nothing left here - all caught up_ ✅" },
    });
    return blocks;
  }

  items.forEach((rec) => {
    blocks.push(...buildRecommendationPairBlocks(items, rec));
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
 * Applies a button action to the recommendations array, returning a NEW
 * array (does not mutate the input). No-ops moving the top item up or the
 * bottom item down.
 *
 * @param {Array<{id: string}>} items
 * @param {string} actedId
 * @param {"item_up"|"item_down"|"item_done"} actionId
 * @returns {Array<object>} the new items array
 */
function applyAction(items, actedId, actionId) {
  const next = items.map((item) => ({ ...item }));
  const index = next.findIndex((item) => item.id === actedId);

  if (index === -1) {
    // Acted item no longer present (shouldn't normally happen) - no-op.
    return next;
  }

  if (actionId === "item_up") {
    if (index > 0) {
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
    }
  } else if (actionId === "item_down") {
    if (index < next.length - 1) {
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
    }
  } else if (actionId === "item_done") {
    next.splice(index, 1);
  }

  return next;
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
};
