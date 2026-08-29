# One-time setup for the optional Home-tab features

Everything here is **optional and independent**. With none of these env vars
set, the bot behaves exactly as before — the new Home sections just show a
short "not connected / not configured" note. Set the env vars on the host
(Render → your service → Environment) and the sections light up on the next
`/update-home` push.

## 📧 Gmail cleanup (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`)

The bot triages your inbox on every Home refresh: important threads bubble
to the top, and promos/lists/no-reply threads that you neither starred nor
replied to are grouped as "low-priority" behind one **🗑️ Archive N** button.

Safety, enforced in code (`src/gmail.js`), not just promised:

- **Archive-only inbox cleanup.** The only Gmail mutations the bot can
  perform are removing the `INBOX` label (archive) and creating a **draft**
  (see draft-only delivery below). There is no code path that trashes,
  deletes, or **sends** — sending is always your own manual act, from Gmail.
- **Starred threads and threads you replied to are never archived** — they
  are excluded at triage time and re-checked again right before each
  archive call.

You create the credentials yourself through Google's normal consent flow —
the bot never sees your password:

1. Go to <https://console.cloud.google.com/>, create (or pick) a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External, fill in the app
   name/email, and add yourself as a **Test user** (leaving the app in
   Testing mode is fine — it's just you).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → Application type **Web application** → add
   `https://developers.google.com/oauthplayground` as an authorized
   redirect URI. Note the **Client ID** and **Client secret**.
5. Mint the refresh token at <https://developers.google.com/oauthplayground>:
   - Gear icon (top right) → check **Use your own OAuth credentials** →
     paste the client ID/secret from step 4.
   - Step 1: enter the scopes (space-separated)
     `https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose`
     → **Authorize APIs** → sign in and consent. `gmail.compose` is what
     lets draft-only delivery write real Gmail drafts — compose can create
     drafts but cannot send: the app contains no send call anywhere, so a
     draft only ever leaves your Drafts folder when you press Send yourself.
   - Step 2: **Exchange authorization code for tokens** → copy the
     **Refresh token**.
6. Set the env vars:

   ```
   GMAIL_CLIENT_ID=<client id>
   GMAIL_CLIENT_SECRET=<client secret>
   GMAIL_REFRESH_TOKEN=<refresh token>
   ```

Optional: `GMAIL_SCAN_LIMIT` (default 50, max 100) — how many inbox threads
each triage pass inspects.

Why `gmail.modify` and not something narrower: it is the least-privileged
standard scope that allows changing labels (archiving = removing `INBOX`).
`gmail.readonly` cannot archive; the code still restricts itself to
label-removal only.

## 💬 Slack needs you (`SLACK_USER_TOKEN`)

A read-only section listing your most recent unread mentions, replies in
threads you participate in (even when they don't @-mention you — the scan
follows your recent threads and surfaces ones you haven't answered), and
unread DMs, **ranked** — leadership first (name fragments from the optional
`SLACK_LEADERSHIP_NAMES` env var, comma-separated, default `ben`), direct
questions next, then newest — with a one-line "why this matters" per item
and a **📥 Capture as task** button that queues the item into triage (same
`triage_add` entry as the "Add to Triage" message shortcut).
**Honest limitation:** Slack's Web API has no bulk mark-as-read or
"clean up my inbox" endpoint, so this section only *surfaces* what needs
you — clicking through is the cleanup. (Gmail can archive in bulk; Slack
can't.)

This needs a *user* token (acts as you, read-only), not the bot token:

1. Open <https://api.slack.com/apps> → this app → **OAuth & Permissions**.
2. Under **User Token Scopes** (not Bot Token Scopes) add the minimal read
   set:
   - `search:read` — find recent messages that mention you (and your own
     recent messages, which seed thread-following)
   - `im:read` — list your DM conversations (unread counts)
   - `im:history` — read DM message metadata
   - `channels:history` — read thread replies in public channels; powers
     thread-following
   - `groups:history` — read thread replies in private channels; powers
     thread-following
   - `users:read` *(optional)* — show DM partners and thread repliers by
     name instead of user id
3. **Reinstall to Workspace** (Slack will show you exactly these scopes),
   then copy the **User OAuth Token** (`xoxp-…`).
4. Set `SLACK_USER_TOKEN=xoxp-…`.

Optional: `SLACK_DM_SCAN_LIMIT` (default 60) — how many recent DM
conversations are checked for unreads per refresh — and
`SLACK_THREAD_SCAN_LIMIT` (default 20, max 50) — how many of your recent
threads the thread-following scan checks for unanswered replies.

## 📅 Calendar quick actions — no setup

The Calendar section always renders. The block buttons ("Block 30m
heads-down now", "Block Slack+Gmail cleanup tomorrow") queue
`calendar_block` entries onto the existing delegation queue
(`GET /delegations/pending`), and the hourly assistant sweep executes them —
the same pattern as every other Home button.

"Flag a meeting to move" opens a **picker modal**: choose one of your
upcoming meetings (the list comes from the latest brief's `meetings`
payload — if it's empty, the modal says the next brief will populate it)
and type where/when to move it. Submitting queues a `calendar_move` entry
carrying the meeting's title, start time, organizer, and your requested
change — everything the hourly sweep needs to act.

## 🤖 AI drafting (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`)

Lets draft-only delivery (below) *write* the email/Slack reply for you when
the request doesn't include the text. **Both** env vars are required — with
either unset the feature is fully off (a `POST /drafts` without `text` just
returns a config error) and the bot behaves exactly as before. The model id
deliberately lives in config, not code.

Get an API key:

1. Go to <https://console.anthropic.com/> and sign in (create an account if
   needed).
2. **API Keys → Create Key**, copy the key.
3. Set the env vars:

   ```
   ANTHROPIC_API_KEY=<your key>
   ANTHROPIC_MODEL=<the model id you want to use>
   ```

Everything generated is a **draft**: it lands in Gmail Drafts or your CoS
channel for you to review — nothing is ever sent automatically.

## 📬 Draft-only delivery (`COS_CHANNEL`)

`POST /drafts` (same `X-Internal-Secret` auth as `/render-brief`) gets a
reply into your hands ready to send — the app **never sends as you**: there
is no `gmail.send` and no user-token `chat:write` anywhere in the code.

- **Email drafts** (needs the Gmail env vars above, including the
  `gmail.compose` scope): a real draft is created in your Gmail Drafts
  folder, and — when `COS_CHANNEL` is set — the bot posts an
  **📬 Open in Gmail Drafts** button to your CoS channel.
- **Slack drafts** (needs `COS_CHANNEL`): the bot posts the ready-to-paste
  text to your CoS channel in a copyable code block, plus a deep link to
  the target conversation. You paste and send it yourself.

Set `COS_CHANNEL` to the channel id of the private CoS channel/DM where your
briefs already land (the bot must be a member).
