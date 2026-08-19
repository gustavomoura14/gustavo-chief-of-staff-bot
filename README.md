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
`{"items": [{"id","text","link?","done"}...all current recommendations in
order...], "actedId": "<this item's id>"}`. When a button is clicked, Slack
POSTs that payload to `/slack/interactions`. The server verifies the request
signature, **acks immediately with an empty HTTP 200** (Slack ignores the ack
body for `block_actions` message updates, so responding with
`replace_original` in the ack does nothing), then decodes `items`/`actedId`
from the clicked button's `value`, applies the action, rebuilds the
recommendations blocks, and **POSTs the update to the payload's
`response_url`** with `{ replace_original: true, blocks, text }`
(`Content-Type: application/json`). That follow-up POST is what actually
replaces the original message.

Action semantics:

- 🔼 / 🔽 (`item_up` / `item_down`): swap the item with its previous/next
  **not-done** neighbor. No-ops at the top/bottom boundaries. Not-done items
  are numbered (`1.`, `2.`, ...) counting non-done items only, and renumber
  on every rebuild.
- ✅ (`item_done`): marks the item done — it is **not removed**. It stays in
  the list rendered as "✅ ~struck-through text~" with no action buttons, and
  done items sort to the bottom of the recommendations list on rebuild.
- 🤖 Do it (`item_delegate`): only present on recommendations sent with
  `delegatable: true` (default `false`). Clicking it pushes the item onto the
  in-memory **delegation queue** (see `/delegations/pending` below; the
  item's link is recovered from the message's accessory URLs) and re-renders
  the item's line as "🤖 _queued: text_" with **all** buttons (🔼/🔽/✅/🤖)
  removed. The delegated item **stays in place** — it is not marked done and
  is not sorted to the bottom. In button `value` payloads, delegatable items
  carry a compact `d: 1` flag and delegated ones carry `delegated: true`.

To avoid losing the sections above the recommendations on update (the button
`value` only carries recommendations), the recommendations header block has a
stable `block_id` (`recs_header`). The handler takes the original message's
blocks from `payload.message.blocks`, keeps everything above that header, and
replaces everything from the header down with the rebuilt recommendations
blocks. If `payload.message.blocks` is missing, it falls back to just the
rebuilt recommendations blocks.

**Block-limit guard:** each not-done recommendation costs 2 blocks (section +
actions). When a payload carries more than 12 recommendations, the per-item
buttons are capped (🔼/🔽 are skipped) to stay under Slack's message
block/size limits — a large digest previously tripped `invalid_blocks`.
Non-delegatable items keep just ✅; delegatable items keep ✅ **and** 🤖 Do
it. The rebuild path uses the same builder as `/render-brief`, so block
counts stay consistent between the initial post and updates.

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
      { "id": "2", "text": "Congratulate the team on the launch", "delegatable": true }
    ]
  }
  ```
  `thread_ts` is optional (omit to post as a new top-level message).
  `priority_recap`, `sections`, and `recommendations` are all optional.
  A recommendation with `delegatable: true` gets an extra "🤖 Do it" button
  (see the action semantics above); the default is `false`.
- **Custom titles** (optional): `title` replaces the default "Morning Brief"
  header title (e.g. `"Week Ahead"`, `"EOD Close-out"`), and `emoji` is
  prepended when given (e.g. `"🌙"`). Rules:
  - Neither given → the classic `☀️ Morning Brief — <date>`.
  - `title` only → `<title> — <date>` (no default emoji is forced; the title
    may embed its own, e.g. `"📅 Week Ahead"`).
  - `emoji` given → `<emoji> <title-or-default> — <date>`.
  The date stamp (`— Friday, August 14`) is always appended, and the
  message's notification fallback `text` mirrors the rendered header.
- Calls Slack's `chat.postMessage` and returns:
  ```json
  { "ok": true, "ts": "1700000000.000100" }
  ```
  or, if Slack rejected the request:
  ```json
  { "ok": false, "error": "channel_not_found" }
  ```
  This reflects Slack's actual response — it is not echoed blindly.

### `POST /update-home`

Publishes an **App Home "bandwidth meter"** view for a user via Slack's
`views.publish`. Intended to be refreshed by the morning brief and the EOD
close-out.

- Auth: header `X-Internal-Secret` must match `INTERNAL_API_SECRET` (same
  scheme as `/render-brief`). Missing or wrong → `401`.
- Body (`Content-Type: application/json`):

  | Field | Type | Meaning |
  | --- | --- | --- |
  | `user` | string, **required** | Slack user ID whose App Home to publish (e.g. `U0A7P92MZ8X`). |
  | `date_label` | string | Shown in the header, e.g. `"Fri Aug 15"`. |
  | `meeting_hours_today` | number | Hours in meetings today. |
  | `focus_hours_today` | number | Open focus hours today. |
  | `meetings_this_week` | number | Meeting count this week. |
  | `meeting_hours_week` | number | Meeting hours this week. |
  | `pending_items` | number | Open pending items. |
  | `new_today` | number | Items new today. |
  | `on_call` | boolean | Renders `🔴 yes` / `—`. |
  | `notes` | string[] | Short lines, one context row each. |
  | `burndown` | object | Optional inbox burn-down bar — see below. |
  | `projects` | object | Optional Zero-missions board (replaces the burn-down bar) — see below. |
  | `tasks` | object[] | Optional triage-board tasks — see below. |

  **All numeric fields are optional** — only fields actually present are
  rendered (no empty rows).

#### `burndown` (optional)

```json
{ "baseline": 10, "current": 6, "slack_unreads": 2, "email_unreads": 4 }
```

Rendered **above the triage section**: a 10-segment `█`/`░` bar of the
cleared fraction `(baseline - current) / baseline` (clamped to 0–1), an
"X of Y cleared" label, and a breakdown context line
`💬 N Slack | 📧 N Email`. Special cases:

- `current === 0 && baseline > 0` → a celebratory **"🎉 Inbox Zero!"**
  header replaces the bar.
- `baseline` absent, non-numeric, or `0` → the whole section is skipped.

#### `projects` (optional)

```json
{ "gmail": { "count": 201 }, "slack": { "count": 10 } }
```

When present, a **"🎯 Projects"** Zero-missions board renders **instead of**
the burn-down bar (when both fields are present, `projects` wins; payloads
with only `burndown` render the old bar unchanged). One row per mission:

- `📧 *Gmail → Zero* — N in inbox` with a **🧹 Start sweep** button
  (`action_id: "project_gmail_zero"`, value `{"type":"gmail_zero_start"}`);
- `💬 *Slack → Zero* — N awaiting reply` with a **🧹 Start sweep** button
  (`action_id: "project_slack_zero"`, value `{"type":"slack_zero_start"}`).

A `count` of `0` renders `✨ at zero` with no button; a mission whose
`count` is absent/non-numeric is skipped. Clicking **🧹 Start sweep**
queues a `gmail_zero_start` / `slack_zero_start` delegation entry and
best-effort re-publishes the Home view with the row marked
"→ 🧹 sweep queued" (button removed).

#### `tasks` (optional)

```json
[
  { "id": "t1", "text": "Reply to vendor thread", "source": "slack",
    "link": "https://…", "status": "todo" }
]
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string, required | Stable task id (echoed back on completion). |
| `text` | string, required | Task text. |
| `source` | `"slack"` \| `"email"` \| `"manual"` | Rendered as 💬 / 📧 / 📝 (default 📝). |
| `link` | string | The task text is hyperlinked to it. |
| `status` | `"todo"` \| `"doing"` | `"doing"` adds a 🔄 marker. |

When present and non-empty, a **"📥 Triage"** section is rendered below the
bandwidth meter (and below the burn-down bar / projects board): one
section+actions pair per task — the task text (hyperlinked to `link` when
present) plus a buttons row with **✅ Complete** (`action_id:
"task_complete"`, whose `value` carries `{taskId, text, source, link}`) and
**🤖 Do it** (`action_id: "home_task_bot"`, whose `value` carries
`{id, text (≤140 chars), link?, source?}`) — both values stay under Slack's
2000-char button-value cap. At most **20 tasks** are rendered (two blocks
each, keeping the Home view safely under Slack's 100-block limit); extras
collapse into an "…and N more" context line.

Clicking **✅ Complete** pushes a `task_complete` entry onto the delegation
queue (see `/delegations/pending`) and best-effort re-publishes the Home
view without that row for instant feedback; clicking **🤖 Do it** pushes a
`bot_do` entry and re-publishes with the row marked "→ 🤖 queued" (buttons
removed). The next scheduled `/update-home` push is the authoritative
refresh either way.
- The view shows a 10-segment `█`/`░` meter of today's meeting load,
  `meeting_hours_today / (meeting_hours_today + focus_hours_today)`, with a
  plain-English read: 🟢 Light day (<34%), 🟡 Balanced (34–67%),
  🔴 Meeting-heavy (>67%).
- Responds with Slack's actual result: `{ "ok": true }` on success, or
  `{ "ok": false, "error": "<slack error>" }` when Slack rejects the publish.
- Example:

  ```bash
  curl -X POST https://<your-host>/update-home \
    -H 'Content-Type: application/json' \
    -H 'X-Internal-Secret: <INTERNAL_API_SECRET>' \
    -d '{
      "user": "U0A7P92MZ8X",
      "date_label": "Fri Aug 15",
      "meeting_hours_today": 4.5,
      "focus_hours_today": 2.0,
      "meetings_this_week": 23,
      "meeting_hours_week": 18.5,
      "pending_items": 7,
      "new_today": 3,
      "on_call": true,
      "notes": ["TISAX evidence due Mon", "On-call until Fri 5pm"]
    }'
  ```

> **Prerequisite — Home Tab toggle:** the Slack app's **App Home → Show Tabs
> → Home Tab** toggle must be **ON**, or `views.publish` fails — Slack
> returns an error like `"not_enabled_for_app_home"`. If you get any error
> mentioning home / feature not enabled, flip that toggle in the app config
> and retry.

### `POST /slack/interactions`

Slack's interactivity endpoint (block_actions **and** message shortcuts).
Configure this as your Slack app's **Interactivity Request URL**. Verifies
the request using `SLACK_SIGNING_SECRET` (HMAC-SHA256 over
`v0:{timestamp}:{raw_body}`, compared to the `X-Slack-Signature` header;
requests with a timestamp more than 5 minutes old are rejected as replays,
`401`). Not meant to be called directly by anything other than Slack. It
handles three kinds of payloads:

1. **Message-button clicks** (🔼/🔽/✅/🤖 on a brief): acks with an empty
   `200` immediately, then asynchronously POSTs the rebuilt message
   (`{ replace_original: true, blocks, text }`) to the payload's
   `response_url`. A 🤖 click also queues a `type: "calendar"` delegation
   entry.
2. **Home-tab "✅ Complete" clicks** (`action_id: "task_complete"`): Home-tab
   interactions arrive **without** a `response_url`, so the handler just acks
   `200` and queues a `type: "task_complete"` entry
   (`{taskId, text, source, link, clickedAt, status: "pending"}`). It then
   best-effort re-publishes the current Home view minus the completed row
   (via `views.publish`) for instant feedback — the hourly queue drain
   re-publishes the authoritative view later regardless.
3. **"Add to Triage" message shortcut** (`callback_id: "add_to_triage"`):
   acks `200` and queues a `type: "triage_add"` entry
   (`{text, channel, message_ts, permalink, clickedAt, status: "pending"}`,
   text truncated to 300 chars; the permalink is built as
   `https://rivian-vw-tech.slack.com/archives/<channel>/p<ts-without-dot>`).
   No modal in v1 — categorization happens agent-side when the queue is
   drained.

### `GET /delegations/pending`

Returns the delegation-queue entries that are still awaiting an ack. Every
entry has a `type` field telling the consumer which click produced it:

| `type` | Produced by | Extra fields |
| --- | --- | --- |
| `"calendar"` | 🤖 Do it on a brief recommendation | `itemId`, `text`, `link`, `channel`, `message_ts` |
| `"task_complete"` | ✅ Complete on a Home-tab triage row | `taskId`, `text`, `source`, `link` |
| `"bot_do"` | 🤖 Do it on a Home-tab triage row | `task_id`, `text`, `link`, `source` |
| `"gmail_zero_start"` / `"slack_zero_start"` | 🧹 Start sweep on a Home-tab 🎯 Projects row | — |
| `"triage_add"` | "Add to Triage" message shortcut | `text`, `channel`, `message_ts`, `permalink` |

For `"calendar"` entries, `channel`/`message_ts` identify the original brief
message the 🤖 button was clicked in (`null` on entries queued before these
fields existed) — `/delegations/complete` uses them to strike the item out
in that message.

```json
{
  "items": [
    {
      "id": "6f1e2a9c-....",
      "type": "calendar",
      "itemId": "2",
      "text": "Congratulate the team on the launch",
      "link": "https://docs.example.com/q3",
      "channel": "C0123456789",
      "message_ts": "1723700000.000100",
      "clickedAt": "2026-08-14T12:34:56.789Z",
      "status": "pending"
    },
    {
      "id": "a3b2c1d0-....",
      "type": "task_complete",
      "taskId": "t1",
      "text": "Reply to vendor thread",
      "source": "slack",
      "link": null,
      "clickedAt": "2026-08-14T13:00:00.000Z",
      "status": "pending"
    },
    {
      "id": "0d1c2b3a-....",
      "type": "triage_add",
      "text": "Can you own the TISAX evidence collection?",
      "channel": "C0123456789",
      "message_ts": "1723710000.123456",
      "permalink": "https://rivian-vw-tech.slack.com/archives/C0123456789/p1723710000123456",
      "clickedAt": "2026-08-14T13:05:00.000Z",
      "status": "pending"
    }
  ]
}
```

- Auth: header `X-Internal-Secret` must match `INTERNAL_API_SECRET` (same
  scheme as `/render-brief`). Missing or wrong → `401`.
- `id` is a server-generated UUID for the queue entry; for `"calendar"`
  entries `itemId` is the recommendation's own id and `link` is recovered
  from the original message's accessory URLs at click time (`null` when the
  item had no link).
- Entries queued before the `type` field existed are reported as
  `"calendar"`.

### `POST /delegations/ack`

Marks queue entries as handled.

- Auth: header `X-Internal-Secret`, as above. Missing or wrong → `401`.
- Body:
  ```json
  { "ids": ["6f1e2a9c-...."], "status": "done", "note": "optional note" }
  ```
  `status` must be `"done"` or `"failed"`; anything else (or a non-array
  `ids`) → `400`.
- Responds `{ "ok": true, "updated": N }` where `N` is the number of matching
  entries updated. Acked entries stay in the queue but leave the
  `/delegations/pending` list.

### `POST /delegations/complete`

Marks **one** queue entry as handled *and* reflects the outcome back into the
original Slack message the 🤖 button was clicked in (using the entry's stored
`channel`/`message_ts`).

- Auth: header `X-Internal-Secret`, as above. Missing or wrong → `401`.
- Body:
  ```json
  { "id": "6f1e2a9c-....", "status": "done", "note": "optional short text" }
  ```
  `id` is the delegation queue entry's id (from `/delegations/pending`).
  `status` must be `"done"` or `"failed"` (anything else, or a missing/
  non-string `id` → `400`; an unknown `id` → `404`).
- The queue entry is **always marked** with the given status (same semantics
  as `/delegations/ack` — it leaves the pending list), *regardless* of
  whether the message update below succeeds.
- Message update: the original message's current blocks are fetched via
  `conversations.history` (`latest=<ts>`, `inclusive=true`, `limit=1`), the
  item's section block is located by its stable `rec_text_<itemId>` block_id
  (falling back to a text match on the entry's stored text), then the message
  is rewritten via `chat.update`:
  - `"done"` → the section text is struck through with a `✔ done — <note>`
    suffix, and the item's `rec_actions_<itemId>` actions block (the block
    immediately following, when it verifiably belongs to that item) is
    removed. All other blocks are untouched.
  - `"failed"` → the text is prefixed with `⚠️` and the note appended — no
    strikethrough, actions kept.
- Responds with Slack's real result: `{ "ok": true, "ts": ..., "channel": ... }`
  on a successful `chat.update`, or `{ "ok": false, "error": "<why>" }` when
  the message couldn't be found/updated (`no_message_reference` for entries
  without a stored `channel`/`message_ts` — e.g. Home-tab `task_complete`
  entries, which don't need this since the Home view is re-published by
  routine updates anyway; `message_not_found` / `item_block_not_found` /
  Slack's own error otherwise). **The entry is marked either way** — an
  `ok: false` only means the visual strikeout didn't happen.

## Queue durability

The delegation queue lives in memory **and is mirrored to a JSON file on
every mutation** (push, ack, complete): `<DATA_DIR>/delegations.json`, where
`DATA_DIR` is an optional env var defaulting to the OS temp dir. On startup
the file, if present, is loaded back. Writes are atomic (write-to-temp +
rename) and best-effort — a persistence failure is logged but never breaks
the queue.

> **Residual risk:** this survives process restarts, crashes, and same-
> instance redeploy restarts — but a **full instance re-provision** (e.g.
> Render's free tier moving the service to a fresh machine/filesystem, where
> the temp dir starts empty) still loses the file. That window is much
> smaller than the old lose-on-every-restart behavior; for zero loss, point
> `DATA_DIR` at a persistent disk. Drain the queue promptly regardless.

## Required environment variables

| Variable | Description |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) with `chat:write` scope. |
| `SLACK_SIGNING_SECRET` | From your Slack app's **Basic Information** page, used to verify interactivity requests. |
| `INTERNAL_API_SECRET` | Shared secret you choose; required in the `X-Internal-Secret` header on `/render-brief`. |
| `PORT` | Port to listen on (Render sets this automatically; defaults to `3000` locally). |
| `DATA_DIR` | *Optional.* Directory for the persisted delegation queue file (`delegations.json`); defaults to the OS temp dir. Point it at a persistent disk for maximum durability. |
| `SLACK_API_BASE` | *Optional, tests only.* Overrides the Slack Web API base URL (`https://slack.com/api`) so local tests can target a mock server. Leave unset in production. |

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

## Slack app config for the "Add to Triage" message shortcut

In your Slack app's configuration (`https://api.slack.com/apps` → your app):

1. **Interactivity & Shortcuts** → make sure Interactivity is **On** and the
   Request URL points at `https://<your-host>/slack/interactions` (shortcuts
   are delivered to the same URL as button clicks).
2. **Create New Shortcut** → **On messages**:
   - Name: `Add to Triage`
   - Short description: e.g. `Queue this message on the triage board`
   - Callback ID: `add_to_triage`
3. Save — the shortcut appears in every message's "More actions" (⋯) menu.
   Reinstall the app if Slack prompts you to.

Equivalent app-manifest snippet:

```yaml
features:
  shortcuts:
    - name: Add to Triage
      type: message
      callback_id: add_to_triage
      description: Queue this message on the triage board
```

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
  payloads; the only server-side state is the delegation queue, mirrored to
  a local JSON file (see "Queue durability").
- Uses Node's built-in `crypto` for signature verification and the global
  `fetch` (Node 18+) for calling Slack's Web API — no extra dependencies
  beyond `express`.
