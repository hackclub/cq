# Airtable setup

CQ uses separate Airtable tables for each kind of record. Airtable data is not
encrypted: each record has useful summary columns and a formatted, readable JSON
document containing the complete application value. Airtable access permissions
are the database security boundary.

## Create or migrate the tables

Set these server environment values:

```env
AIRTABLE_PAT=your_pat
AIRTABLE_BASE_ID=your_base_id
AIRTABLE_TABLE_PREFIX=CQ
AIRTABLE_TABLE_NAME=CQ Data
```

`AIRTABLE_TABLE_PREFIX` keeps development and production tables separate. For
example, `DEV CQ` creates `DEV CQ Users`, `DEV CQ Projects`, and so on.

Temporarily grant the PAT `schema.bases:read`, `schema.bases:write`,
`data.records:read`, and `data.records:write`, scoped only to the CQ base. Then
run:

```sh
npm run airtable:setup
```

By default this configures both table namespaces in the same base: `DEV CQ ...`
for development and `CQ ...` for production. It prints verbose progress for
every table, field, and migrated record. Only `AIRTABLE_BASE_ID` is required.

With Docker Compose, use:

```sh
docker compose run --rm cq npm run airtable:setup
```

The command is repeat-safe. It creates missing tables and copies records from
the older `AIRTABLE_TABLE_NAME` table when present. Existing destination records
are skipped, and the legacy table and its records are never edited or deleted.
After setup, `schema.bases:write` can be removed from the PAT; the running app
only needs record read/write access.

If old rows begin with `v1.`, provide their original `DATA_ENCRYPTION_KEY` while
running the migration. New Airtable records are always readable and unencrypted.

## Tables and fields

The prefix is followed by these table names:

- Users, Projects, Devlogs, Submissions, Orders, Shop Products, and Countries
- Review Actions, Audit Log, Hertz Ledger, Slack Notifications, and Ari Deliveries
- Carts, Sessions, OAuth States, Hackatime OAuth States, Hackatime Tokens, and
  Hackatime Cache

Every table contains:

| Field | Airtable type | Purpose |
| --- | --- | --- |
| `ID` | Single line text, primary | Stable CQ record ID |
| `Name` | Single line text | Human-readable record name |
| `Status` | Single line text | Current state or action |
| `Owner` | Single line text | Related user, project, or organizer |
| `Data` | Long text | Complete formatted JSON record |
| `Updated At` | Date with time | Last CQ write |

The `Name`, `Status`, and `Owner` fields make normal Airtable views useful while
`Data` preserves the full application record without encryption.

## Launch rollout

1. Back up the legacy table or duplicate the base.
2. Stop the CQ server so records cannot change during migration.
3. Run `npm run airtable:setup` and inspect several records in each populated table.
4. Start the updated CQ server and check `/healthz`.
5. Sign in and test a project, devlog, review, shop order, role change, and audit entry.
6. Keep the legacy table until after launch; do not delete it during the cutover.

Limit the PAT and base sharing to trusted organizers. Website roles control the
organizer dashboard but do not grant or revoke direct access to the Airtable base.

For local development without Airtable, CQ still encrypts `data/cq.local.json`.
