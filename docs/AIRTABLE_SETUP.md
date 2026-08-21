# Airtable setup

CQ uses Airtable as its production source of truth. Records are stored as
readable JSON so trusted base collaborators can inspect and support the program.
Airtable access permissions are the database security boundary.

Create a base and one table named `CQ Data` with these fields:

| Field | Airtable type | Notes |
| --- | --- | --- |
| `Key` | Single line text | Primary field |
| `Type` | Single line text | Entity type, not sensitive |
| `Payload` | Long text | Readable JSON document |
| `Updated At` | Date with time | Include time |

Create a Personal Access Token scoped only to this base with
`data.records:read` and `data.records:write`. Put the full token and base ID in
the server environment as `AIRTABLE_PAT` and `AIRTABLE_BASE_ID`.

For local development without Airtable, CQ encrypts `data/cq.local.json`.
`DATA_ENCRYPTION_KEY` is optional when Airtable is configured, but should be set
for durable local-file data.

Older CQ releases wrote `v1.…` encrypted Airtable payloads. If the base contains
those rows, keep their original `DATA_ENCRYPTION_KEY` in the server environment.
CQ reads them during startup and rewrites them as readable JSON after the full
table has loaded successfully. Never delete live rows merely because they use
the legacy format, and keep a backup until the one-way migration has completed.

Limit the Personal Access Token and base sharing to trusted organizers. The
website's reviewer/shop/fulfilment roles do not replace Airtable's own access
controls for people who can open the base directly.
