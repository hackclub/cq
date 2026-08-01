# CQ

CQ is a full-stack Hack Club YSWS app for making ham-radio projects, documenting
the work, submitting builds for review, earning hertz, and ordering radio gear.
Eligible projects can be electronics hardware or software, but they must directly
relate to ham radio. Studying or completing a course alone is not an eligible
project.

## What is included

- Hack Club Auth OIDC sign-in with verified ID-token claims, state, nonce, PKCE,
  encrypted server sessions, CSRF protection, and admin roles
- Project creation and editing, milestones, timed work logs, evidence, project
  updates, submission, status refresh, withdrawal, and decision history
- Ari request signing, signed webhook verification, a five-minute replay window,
  idempotent delivery handling, approval ledger, and reversal handling
- A real shop with encrypted shipping details, stock control, carts, locked
  balance/stock checks, hertz balances, cancellation refunds, order history,
  and fulfilment tracking
- Slack direct-message notifications for submission, review, requested changes,
  approval, denial, purchase, and order-status changes
- An organizer dashboard for users, projects, Ari deliveries, products, orders,
  hertz adjustments, and editable country policies
- Airtable production storage with every application document encrypted using
  AES-256-GCM before it leaves the Node server

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
2. Follow [the Airtable setup](docs/AIRTABLE_SETUP.md), generate a unique data
   encryption key, and keep that key in the host's secret manager.
3. Add the Ari program and signing secrets. Configure Ari's outgoing webhook URL
   as `https://your-domain.example/ari/webhook`.
4. Create a Slack app with `chat:write`, install it to the Hack Club workspace,
   then set `SLACK_BOT_TOKEN`. `SLACK_ADMIN_CHANNEL_ID` is optional and receives
   organizer-facing purchase notices.
5. Set `ADMIN_EMAILS` to a comma-separated list of organizer Hack Club email
   addresses. Those accounts receive the admin role when they sign in.
6. Set `BASE_URL`, `NODE_ENV=production`, and all remaining values documented in
   `.env.example`.

All credentials are server-only environment variables. Do not add `.env` to
source control.

## Country policies

Country rules are seeded conservatively and can be edited under **Admin →
Countries**. Each policy separately describes ownership, transmission, and
fulfilment. Orders snapshot the applicable fulfilment policy so a later policy
edit does not erase the decision context.

The participant interface tells makers to check current official rules before
buying, importing, or transmitting. Seed text is operational guidance, not legal
advice. Organizers should periodically verify it against the linked regulator.

## Storage and security

The Airtable table contains only a key, a coarse record type, ciphertext, and an
updated timestamp. Names, emails, addresses, Slack IDs, project details, order
contents, sessions, and review payloads all remain inside authenticated
ciphertext.

Back up `DATA_ENCRYPTION_KEY` securely. Losing it makes the stored payloads
unrecoverable; exposing it compromises the database. Rotate Hack Club, Slack,
Ari, and Airtable credentials through the deployment secret manager rather than
storing them in Airtable.
