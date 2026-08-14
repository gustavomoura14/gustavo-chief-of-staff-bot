# Chief of Staff Bot

A small, stateless Node.js/Express backend for a custom Slack app called
"Chief of Staff". It renders a Block Kit "Morning Brief" message (urgent
items, calendar conflicts, other named sections, and a re-rankable
"Reply-worthy" recommendations list), posts it into Slack, and handles the
🔼/🔽/✅ button clicks by rebuilding and re-posting the message in place — no
database, no server-side state. Everything needed to redraw the
recommendations list is encoded in the button's `value` field.

## How it works

`POST /render-brief` builds the message from a `channel`/`thread_ts`, an
optional `priority_recap`, an array of named `sections` (each with a title
and a list of `{text, link?, flag?}` items), and an array of `recommendations`
(`{id, text, link?}`), then calls Slack's `chat.postMessage`.

Each recommendation's 🔼/🔽/✅ buttons carry a `value` that is a JSON string:
`{"items": [...all current recommendations in order...], "actedId": "<this item's id>"}`.
When a button is clicked, Slack POSTs that payload to `/slack/interactions`.
The server verifies the request signature, decodes `items`/`actedId` from the
clicked button's `value`, applies the action (move up / move down / mark
done), rebuilds just the recommendations blocks from the new array, and
responds immediately with `{ replace_original: true, blocks, text }` — which
is how Slack updates the original message directly from the interactivity
response, with no outbound Slack API call required.

Items/recommendations with a `link` get a "Open" URL button **accessory**
(not an actions-block button) — Slack opens these directly client-side, so
they work even if this server is asleep/cold. No interactivity request is
ever sent to this server for those.

## Endpoints

### `GET /healthz`

Returns `{"status":"ok"}`. Used for hosting health checks and as a keep-warm
ping target (see "Keeping /slack/interactions warm" below).

### `POST /render-brief`

The main entrypoint (e.g. called by a scheduled routine every morning).

- Auth: header `X-Internal-Secret` must match `INTERNAL_API_SECRET`. Missing
  or wrong → `401`.
- Body:
  ```json
  {
    "channel": "C0123456789",
    "thread_ts": "1700000000.000000",
    "priority_recap": "Two urgent asks and a scheduling conflict before 10am.",
    "sections": [
      {
        "title": "Urgent",
        "items": [
          { "text": "Reply to vendor contract deadline", "link": "https://mail.example.com/x", "flag": "overdue" }
        ]
      },
      {
        "title": "Calendar conflicts",
        "items": [
          { "text": "10am 1:1 overlaps with Board prep block" }
        ]
      }
    ],
    "recommendations": [
      { "id": "1", "text": "Approve the Q3 roadmap doc", "link": "https://docs.example.com/q3" },
      { "id": "2", "text": "Congratulate the team on the launch" }
    ]
  }
  ```
  `thread_ts` is optional (omit to post as a new top-level message).
  `priority_recap`, `sections`, and `recommendations` are all optional.
- Calls Slack's `chat.postMessage` and returns:
  ```json
  { "ok": true, "ts": "1700000000.000100" }
  ```
  or, if Slack rejected the request:
  ```json
  { "ok": false, "error": "channel_not_found" }
  ```
  This reflects Slack's actual response — it is not echoed blindly.

### `POST /slack/interactions`

Slack's interactivity endpoint (block_actions). Configure this as your Slack
app's **Interactivity Request URL**. Verifies the request using
`SLACK_SIGNING_SECRET` (HMAC-SHA256 over `v0:{timestamp}:{raw_body}`,
compared to the `X-Slack-Signature` header; requests with a timestamp more
than 5 minutes old are rejected as replays, `401`). Not meant to be called
directly by anything other than Slack.

## Required environment variables

| Variable | Description |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) with `chat:write` scope. |
| `SLACK_SIGNING_SECRET` | From your Slack app's **Basic Information** page, used to verify interactivity requests. |
| `INTERNAL_API_SECRET` | Shared secret you choose; required in the `X-Internal-Secret` header on `/render-brief`. |
| `PORT` | Port to listen on (Render sets this automatically; defaults to `3000` locally). |

See `.env.example`.

## Running locally

```bash
npm install
cp .env.example .env   # fill in real values
npm start
```

Then:

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

## Deploying to Render (free web service tier)

1. Push this repo to GitHub (e.g. `github.com/gustavomoura14/gustavo-chief-of-staff-bot`).
2. In Render, create a new **Web Service** from that repo.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add the environment variables above (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
   `INTERNAL_API_SECRET`) in Render's Environment settings. Render sets `PORT`
   itself.
6. Once deployed, copy the Render service URL (e.g.
   `https://gustavo-chief-of-staff-bot.onrender.com`) and set it as the
   **Interactivity Request URL** in your Slack app's configuration
   (`https://api.slack.com/apps` → your app → Interactivity & Shortcuts):
   ```
   https://<your-render-url>/slack/interactions
   ```
7. Make sure the Slack app's bot token has the `chat:write` scope and the bot
   is invited to any channel it needs to post in.

## Keeping /slack/interactions warm

For `/slack/interactions` to work reliably even when the free-tier instance
has spun down, set up a free external pinger (e.g.
[cron-job.org](https://cron-job.org)) hitting `GET /healthz` every ~10
minutes during your active hours (e.g. 7am–7pm weekdays) to keep the instance
warm.

This is **not** needed for `/render-brief` itself — that's only called on a
schedule, so a brief cold-start delay there is harmless. It **is** needed
once someone might click a recommendation's 🔼/🔽/✅ button at an
unpredictable time: if the instance is asleep, Slack's interactivity request
can time out before the server wakes up.

Link-only items (rendered as a plain "Open" URL button) never need the
server to be warm — Slack opens those links directly and never sends an
interactivity request to this server for them.

## Notes

- No database or external state store is used, by design. All state needed
  to redraw the recommendations list travels inside the button `value`
  payloads.
- Uses Node's built-in `crypto` for signature verification and the global
  `fetch` (Node 18+) for calling Slack's Web API — no extra dependencies
  beyond `express`.
