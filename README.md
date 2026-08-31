# CQ

CQ is a full-stack Hack Club YSWS app for making ham-radio projects, documenting
the work, submitting builds for review, earning hertz, and ordering radio gear.
Eligible projects can be electronics hardware or software, but they must directly
relate to ham radio. Studying or completing a course alone is not an eligible
project.

CQ's submission gate and reviewer checklist implement the current
[Hack Club YSWS Project Submission Guidelines](https://hackclub.gitbook.io/ysws-project-submission-guidelines/BLBRN8LIfoCZhFV6oMNR),
including shipped/reproducible projects, required evidence, eligibility exceptions,
auditable hour decisions, and distinct hours for project updates.

## What is included

- Hack Club Auth OIDC sign-in with verified ID-token claims, state, nonce, PKCE,
  encrypted local server sessions, CSRF protection, and permission-based organizer roles
- Project creation and editing, Markdown devlogs timed from new
  linked-project Hackatime activity, drag-and-drop CDN image uploads, evidence,
  project updates, submission, status refresh, withdrawal, and decision history
- Hackatime OAuth account linking and automatic, selectable project discovery;
  access tokens remain server-side in the access-controlled data store
- Ari request signing, signed webhook verification, a five-minute replay window,
  idempotent delivery handling, approval ledger, and reversal handling
- A real shop with access-controlled shipping details, stock control, carts, locked
  balance/stock checks, hertz balances, cancellation refunds, order history,
  and fulfilment tracking
- Slack direct-message notifications for submission, review, requested changes,
  approval, denial, purchase, and order-status changes
- An on-platform review queue with claiming, private notes, participant feedback,
  decisions, approved-time rewards, audit history, and Slack notifications
- Separate reviewer, shop editor, fulfilment, country editor, support, and admin roles
- Separate Airtable tables with readable summary columns and unencrypted JSON documents
- A centralized organizer audit log for roles, hertz, reviews, orders, shop items, projects, and country policies

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

Set `DEV_AUTH_BYPASS=true` only for a local preview. It exposes a development
sign-in form and is disabled automatically in production and test environments.

Run the automated suite with:

```sh
npm test
```

## Production setup

1. Create a Hack Club Auth app and set its callback to
   `https://cq.hackclub.com/auth/callback`. Add the client ID, secret, and
   exact callback URI to the server environment.
2. Create a confidential Hackatime OAuth app under **My OAuth Apps**, set its
   exact callback to `https://your-domain.example/app/hackatime/callback`, and
   add its client ID and secret. CQ requests the `profile read` scopes.
3. Follow [the Airtable setup](docs/AIRTABLE_SETUP.md), then run
   `npm run airtable:setup`. CQ creates separate readable tables and safely copies
   records from the older single-table layout without deleting the old data.
4. Add the Ari program and signing secrets. Configure Ari's outgoing webhook URL
   as `https://your-domain.example/ari/webhook`.
5. Create a Slack app with `chat:write`, install it to the Hack Club workspace,
   then set `SLACK_BOT_TOKEN`. `SLACK_ADMIN_CHANNEL_ID` is optional and receives
   organizer-facing purchase notices.
6. Create a server API key in [Hack Club CDN](https://cdn.hackclub.com/api_keys)
   and set `HACKCLUB_CDN_API_KEY`. CQ uses it for permanent devlog image uploads;
   the key is never sent to participants' browsers.
7. Set `ADMIN_EMAILS` to a comma-separated list of organizer Hack Club email
   addresses. Those accounts receive the admin role when they sign in.
8. Set `BASE_URL`, `NODE_ENV=production`, and all remaining values documented in
   `.env.example`.

Hackatime compares redirect URIs exactly. For the production domain in this
repository, register this URI as its own line in **My OAuth Apps**:

```text
https://cq.rubensutton.hackclub.app/app/hackatime/callback
```

Do not add a trailing slash. The admin dashboard shows the callback CQ is
currently using so it can be compared directly with Hackatime after deployment.

All credentials are server-only environment variables. Do not add `.env` to
source control.

## Railpack deployment

CQ is one server-rendered Node application, not a monorepo or a static export.
The included `railpack.json` installs the locked dependencies with `npm ci` and
starts the production server with `npm start`.

If the hosting dashboard overrides repository settings, use:

| Setting | Value |
| --- | --- |
| Root directory | Leave empty |
| Install command | `npm ci` |
| Build command | Leave empty |
| Output directory | Leave empty |
| Start command | `npm start` |

Do not use `apps/web`: that directory does not exist in this repository. Do not
set an output directory, because doing so changes the deployment into a static
site and prevents the Express server, authentication, webhooks, and Slack bot
from running. The host must provide `PORT`; CQ already listens on it.

### Docker deployment

The production `Dockerfile` uses Node 20, installs only locked runtime
dependencies, runs as the unprivileged `node` user, and checks `/healthz` for
container health. On a platform with a Dockerfile builder:

- select **Dockerfile** instead of Railpack;
- leave the root directory empty;
- leave install, build, output, and start overrides empty;
- use `Dockerfile` as the Dockerfile path if the platform asks for one.

The container starts the Express server itself, so a static output directory or
dashboard start command must not be configured. Set the environment variables
from `.env.example` in the platform's secret/environment settings; do not copy
the local `.env` into the image.

For a host that supports Docker Compose, `docker-compose.yml` builds the same
image and passes through every documented setting. Locally, copy `.env.example`
to `.env`, fill in the required production values, then run:

```sh
docker compose up --build -d
docker compose logs -f cq
```

Stop it with `docker compose down`. `CQ_HOST_PORT` changes only the host-side
port if port 3000 is already occupied; `PORT` controls the container port and
defaults to 3000. Compose reads `.env` for substitution but Docker excludes it
from the image.

## Country policies

Country rules are seeded conservatively and can be edited under **Admin →
Countries**. Each policy separately describes ownership, transmission, and
fulfilment. Orders snapshot the applicable fulfilment policy so a later policy
edit does not erase the decision context.

The participant interface tells makers to check current official rules before
buying, importing, or transmitting. Seed text is operational guidance, not legal
advice. Organizers should periodically verify it against the linked regulator.

## Storage and security

Each Airtable entity table contains an ID, readable name/status/owner columns,
an unencrypted formatted JSON document, and an update timestamp. Airtable
permissions are the security boundary, so access to the base must be limited to
trusted organizers. CQ role permissions separately control which organizer
screens are available through the website.

`DATA_ENCRYPTION_KEY` is only needed for encrypted local-file storage and to read
legacy Airtable rows during the explicit migration command. The migration copies
them as readable JSON and leaves the source rows untouched. Rotate Hack Club,
Slack, Ari, and Airtable credentials through the deployment secret manager.
