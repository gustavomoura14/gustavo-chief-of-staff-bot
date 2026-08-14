"use strict";

const crypto = require("crypto");

const FIVE_MINUTES_IN_SECONDS = 60 * 5;

/**
 * Verifies a Slack request signature per Slack's signing secret scheme.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param {object} opts
 * @param {string} opts.signingSecret - process.env.SLACK_SIGNING_SECRET
 * @param {string} opts.timestamp - value of the X-Slack-Request-Timestamp header
 * @param {string} opts.signature - value of the X-Slack-Signature header
 * @param {Buffer|string} opts.rawBody - the raw (unparsed) request body
 * @returns {boolean} true if the signature is valid and not a replay
 */
function verifySlackSignature({ signingSecret, timestamp, signature, rawBody }) {
  if (!signingSecret || !timestamp || !signature || rawBody === undefined) {
    return false;
  }

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampNum) > FIVE_MINUTES_IN_SECONDS) {
    // Possible replay attack - reject old (or clock-skewed-into-the-future) requests.
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const baseString = `v0:${timestamp}:${body}`;

  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(baseString, "utf8");
  const computedSignature = `v0=${hmac.digest("hex")}`;

  const expected = Buffer.from(computedSignature, "utf8");
  const actual = Buffer.from(signature, "utf8");

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { verifySlackSignature };
