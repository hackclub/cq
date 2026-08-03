# Airtable setup

CQ uses Airtable as its production source of truth. The Node server encrypts
each record as a complete AES-256-GCM document before sending it to Airtable.
Airtable only receives a record key, a coarse entity type, ciphertext, and an
updated timestamp.

Create a base and one table named `CQ Data` with these fields:

| Field | Airtable type | Notes |
| --- | --- | --- |
| `Key` | Single line text | Primary field |
| `Type` | Single line text | Entity type, not sensitive |
| `Payload` | Long text | Authenticated ciphertext |
| `Updated At` | Date with time | Include time |

Create a Personal Access Token scoped only to this base with
`data.records:read` and `data.records:write`. Put the full token and base ID in
the server environment as `AIRTABLE_PAT` and `AIRTABLE_BASE_ID`.

Generate the separate application encryption key:

```sh
openssl rand -base64 32
```

Store the result as `DATA_ENCRYPTION_KEY` in the server secret manager. Never
put that key in Airtable. Back it up securely: losing it makes every encrypted
payload unrecoverable, while leaking it compromises the database.

For local development without Airtable, CQ writes the same encrypted document
format to `data/cq.local.json`. Production refuses to start without an explicit
encryption key.

If startup reports that a named Airtable record is not valid CQ ciphertext,
either that row was entered manually or `DATA_ENCRYPTION_KEY` no longer matches
the key that encrypted it. Delete only a clearly disposable placeholder row.
For real CQ data, restore the original encryption key instead—changing the key
cannot decrypt or migrate existing records.
