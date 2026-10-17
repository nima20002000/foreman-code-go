# Captured database baseline

`baseline.sql` is embedded with `capture-provenance.json`. It comes from actual
startup of the pinned TypeScript baseline
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f` against fresh PostgreSQL, followed by a
verified driver restore into a second fresh database through Foreman CI ticket
`ee10dc5b-0cd7-4d30-85eb-7885964966c8`. Provenance records the source identities,
checksums, tools, SQL conversion, and original/restored table row inventories.

`expected-head.json` contains the source-derived migration set. The captured and
restored `application_migrations` ledger matches all 183 versions, including the
final version 2026101702. Checkpoint tables and their five migration records are
retained, along with actual migration and startup seed rows.

The sole excluded data is the startup-generated per-installation Ed25519 private
key in `public.device_main_identity`: original row count 1, restored row count 0.
The table schema is unchanged, and provenance explicitly records this exclusion.
Raw private dumps and capture tooling are not embedded assets.

The TypeScript capture and PostgreSQL driver restore are verified. Foreman CI
ticket `813cd590-3a58-4a52-b733-1672a750a280` also verified Go `schema.Prepare`,
startup/restart, migration history and rollback, and real PostgreSQL-backed HTTP
behavior on the backend tree of `e373f5425fba124b1abb048b76e18434c9e69d57`:
211 ordinary and 26 named integration checks passed without failures or skips.
Full-binary startup, SKEL conformance, and the full CI gate remain unverified.
Follow [the capture instructions](../CAPTURE.md) for recapture and remaining
execution checks. An existing database must still prove the complete expected
application migration set and working checkpoint tables.

Numbered Go migrations belong in `migrations/`. Their applied rows live in a
separate `schema_migrations` table. No baseline row is invented or stamped into
the original TypeScript ledger.
