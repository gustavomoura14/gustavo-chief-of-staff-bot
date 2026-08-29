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

- **Archive-only.** The only Gmail mutation the bot can perform is removing
  the `INBOX` label. There is no code path that trashes or deletes.
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
   - Step 1: enter the scope `https://www.googleapis.com/auth/gmail.modify`
     → **Authorize APIs** → sign in and consent.
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

A read-only section listing your most recent unread mentions and DMs.
**Honest limitation:** Slack's Web API has no bulk mark-as-read or
"clean up my inbox" endpoint, so v1 only *surfaces* what needs you —
clicking through is the cleanup. (Gmail can archive in bulk; Slack can't.)

This needs a *user* token (acts as you, read-only), not the bot token:

1. Open <https://api.slack.com/apps> → this app → **OAuth & Permissions**.
2. Under **User Token Scopes** (not Bot Token Scopes) add the minimal read
   set:
   - `search:read` — find recent messages that mention you
   - `im:read` — list your DM conversations (unread counts)
   - `im:history` — read DM message metadata
   - `users:read` *(optional)* — show DM partners by name instead of user id
3. **Reinstall to Workspace** (Slack will show you exactly these scopes),
   then copy the **User OAuth Token** (`xoxp-…`).
4. Set `SLACK_USER_TOKEN=xoxp-…`.

Optional: `SLACK_DM_SCAN_LIMIT` (default 60) — how many recent DM
conversations are checked for unreads per refresh.

## 📅 Calendar quick actions — no setup

The Calendar section always renders. Its buttons ("Block 30m heads-down
now", "Block Slack+Gmail cleanup tomorrow", "Flag a meeting to move") queue
`calendar_block` / `calendar_move` entries onto the existing delegation
queue (`GET /delegations/pending`), and the hourly assistant sweep executes
them — the same pattern as every other Home button.
