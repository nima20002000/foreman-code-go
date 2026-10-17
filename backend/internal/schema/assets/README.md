# Captured database baseline

`baseline.sql` is deliberately absent. This environment has no `postgres`,
`initdb`, `psql`, or `pg_dump`, and its pnpm is 11.25.0 instead of the source
checkout's pinned 11.27.0. No database was started, migrated, or dumped here.

`expected-head.json` was generated from the exact TypeScript migration metadata
at `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. Its 183 versions are an expected
source-derived set, not observed database rows, executed tests, or conformance
results. The final version is 2026101702. The TypeScript ledger is named
`application_migrations`.

Follow `../CAPTURE.md` to produce and verify the real SQL asset. An empty database
cannot initialize until that asset exists. An existing database must still prove
the complete expected application migration set and working checkpoint tables.

Numbered Go migrations belong in `migrations/`. Their applied rows live in a
separate `schema_migrations` table. No baseline row is invented or stamped into
the original TypeScript ledger.
