# Migrating COSLOBO from Render to Google Cloud Run

Target: project **`rvt-cos-bot-prod-01`**, region **`us-central1`**, service
**`gustavo-chief-of-staff-bot`**.

Nothing in this branch changes the Render deployment: with `STORAGE_BACKEND`
unset, the server behaves exactly as before (JSON-file queue mirror in
`DATA_DIR`). Cloud Run runs the same code with `STORAGE_BACKEND=firestore`, so
the delegation queue finally survives redeploys and re-provisions.

The required APIs (`run`, `cloudscheduler`, `secretmanager`, `firestore`,
`artifactregistry`, `cloudbuild`, `logging`, `monitoring`) are already enabled
on the project.

Run the steps below **in order**.

---

## 0. Auth and project config

```bash
gcloud auth login
gcloud config set project rvt-cos-bot-prod-01
gcloud config set run/region us-central1
```

## 1. Create the secrets (Secret Manager)

The names must match the env vars `src/server.js` reads: `SLACK_SIGNING_SECRET`,
`SLACK_BOT_TOKEN`, `INTERNAL_API_SECRET`. Copy each value from the Render
dashboard (Environment tab of the current service).

```bash
printf '%s' 'PASTE_SIGNING_SECRET_HERE' | gcloud secrets create SLACK_SIGNING_SECRET --data-file=-
printf '%s' 'xoxb-PASTE_BOT_TOKEN_HERE'  | gcloud secrets create SLACK_BOT_TOKEN      --data-file=-
printf '%s' 'PASTE_INTERNAL_SECRET_HERE' | gcloud secrets create INTERNAL_API_SECRET  --data-file=-
```

(`printf '%s'` avoids a trailing newline ending up inside the secret. No code
change was needed for secrets: the server reads all three env vars once at
startup, and Cloud Run injects each Secret Manager secret as a plain env var
via the `--set-secrets` flags in `cloudbuild.yaml`.)

## 2. Create the Firestore database (native mode)

```bash
gcloud firestore databases create --location=us-central1 --type=firestore-native
```

The queue lives in one document: collection `cos-bot`, document `delegations`,
field `entries` (override the collection with the `FIRESTORE_COLLECTION` env
var if ever needed). No schema setup is required.

## 3. Create the Artifact Registry repo

```bash
gcloud artifacts repositories create cos-bot \
  --repository-format=docker --location=us-central1 \
  --description="COSLOBO container images"
```

## 4. Grant the runtime service account access

The service runs as the **default compute service account**
(`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). It needs Firestore
access and permission to read the mounted secrets:

```bash
PROJECT_NUMBER=$(gcloud projects describe rvt-cos-bot-prod-01 --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding rvt-cos-bot-prod-01 \
  --member="serviceAccount:${SA}" --role=roles/datastore.user

for S in SLACK_SIGNING_SECRET SLACK_BOT_TOKEN INTERNAL_API_SECRET; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor
done
```

## 5. First deploy

From the repo root, on this branch:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions SHORT_SHA=$(git rev-parse --short HEAD)
```

This builds the image, pushes it to Artifact Registry, and deploys to Cloud
Run with `--allow-unauthenticated --min-instances=1`, the three secrets wired
in, and `STORAGE_BACKEND=firestore` (plus `KEEP_WARM=off` - min-instances
replaces the Render keep-warm pinger, and the in-process self-ping must not
keep hitting the old Render URL).

Grab the service URL:

```bash
CLOUD_RUN_URL=$(gcloud run services describe gustavo-chief-of-staff-bot \
  --region us-central1 --format='value(status.url)')
echo "$CLOUD_RUN_URL"
```

## 6. Verify before touching Slack

```bash
# Health (public - no secret needed). `version` must equal the deployed short SHA:
curl -s "$CLOUD_RUN_URL/healthz"

# Internal routes: 401 WITHOUT the header...
curl -s -o /dev/null -w '%{http_code}\n' "$CLOUD_RUN_URL/delegations/pending"

# ...and 200 with it (use the same value stored in INTERNAL_API_SECRET):
curl -s -H "X-Internal-Secret: $INTERNAL_SECRET_VALUE" "$CLOUD_RUN_URL/delegations/pending"

# Post a test brief into a DM/test channel (proves SLACK_BOT_TOKEN works):
curl -s -X POST "$CLOUD_RUN_URL/render-brief" \
  -H "X-Internal-Secret: $INTERNAL_SECRET_VALUE" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"YOUR_TEST_CHANNEL_ID","title":"Cloud Run smoke test","recommendations":[{"id":"t1","text":"Test item"}]}'
```

Then verify Firestore persistence end to end:

1. Point the Slack app at Cloud Run **temporarily** (or use the test brief
   above once step 7 is done) and click a button (e.g. 🤖 Do it) on the test
   brief - the click must land without a Slack error banner.
2. `curl -s -H "X-Internal-Secret: ..." "$CLOUD_RUN_URL/delegations/pending"`
   should show the queued entry.
3. Redeploy (rerun step 5) and fetch `/delegations/pending` again - the entry
   must still be there. That is the whole point of the migration.

## 7. Repoint the Slack app

At <https://api.slack.com/apps> → the COSLOBO app, replace the Render host
with `$CLOUD_RUN_URL` in every URL:

- **Interactivity & Shortcuts** → Request URL → `$CLOUD_RUN_URL/slack/interactions`
- **Event Subscriptions** → Request URL (if enabled) → the matching path on `$CLOUD_RUN_URL`
- **App Home** needs no URL, but re-check that the Home tab toggle is still on.

Also update anything external that calls the bot (the scheduled routine that
POSTs `/render-brief` and `/update-home`, and the queue drain that calls
`/delegations/*`) to use `$CLOUD_RUN_URL`.

## 8. Soak, then decommission Render

- Keep the Render service running for **one day** as a fallback (it keeps
  its own file-based queue; nothing conflicts - Cloud Run entries live in
  Firestore).
- After a clean day of briefs + button clicks + queue drains on Cloud Run:
  delete the Render service, and remove the external cron-job.org keep-warm
  pinger for the Render URL.

---

## Watch-outs

- **`ProjectMember` role coverage**: Gustavo and Alex hold the custom
  `ProjectMember` role on `rvt-cos-bot-prod-01`. Before step 5, confirm it
  permits `cloudbuild.builds.create`, `run.services.*`,
  `artifactregistry.repositories.*`, `secretmanager.secrets.create`, and
  `datastore.*` - if a step above fails with a permission error, have a
  project admin extend the role (or grant the standard roles
  `roles/cloudbuild.builds.editor`, `roles/run.admin`,
  `roles/artifactregistry.admin`, `roles/secretmanager.admin`).
- **Default compute service account**: the service currently runs as the
  default compute SA (per project convention). That SA is broader than the
  service needs; creating a dedicated minimal SA (`roles/datastore.user` +
  `roles/secretmanager.secretAccessor` only) and passing it via
  `--service-account` is a good follow-up hardening step, deliberately left
  out of this migration to keep the first deploy simple.
