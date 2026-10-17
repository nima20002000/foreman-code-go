# Capture and verify the TypeScript database baseline

## Current status

The SQL dump is **not captured**. This child environment has no PostgreSQL
server/client/dump tools, no Docker or Podman, no Go or gofmt, and pnpm 11.25.0
instead of the required 11.27.0. No database migration, SQL restore, Go test,
or conformance test has run here. Source-derived migration metadata is not a
substitute for a dump.

The controller must perform the capture on a machine with the required tooling.
Only the separate benchmark repository `nima20002000/foreman-code-go` and fresh,
isolated test resources may be used. No real application database, installation,
port, or paired worker may be reused. Q-CI owns CI configuration; Q-CONF owns the
conformance setup and expectations. Send changes to those owners through the
controller.

## Capture the actual source behavior

1. Create a separate, clean checkout of
   `nima20002000/foreman-code-go` at
   `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. Read its `AGENTS.md`. Verify the
   checkout SHA before starting anything. Install retained TS dependencies with
   its pinned `corepack pnpm install --frozen-lockfile`; never plain npm or an
   unpinned substitute. The source pins pnpm 11.27.0 and requires Node >=22.

2. Reuse the controller/Q-CONF's fresh resource setup (the source has
   `scripts/test-resources.mjs` and `testRuntimeResources.ts`). Provision a fresh
   PostgreSQL database, random loopback API and database ports, an isolated
   HOME and XDG directories, empty harness configuration directories, and
   separate workspace, file, and harness storage under the invocation's private
   root. Supply the existing test ownership marker and environment through that
   setup; do not weaken those checks. Set `NODE_ENV=test` and
   `FOREMAN_CODE_COMPUTER_UPKEEP=0` for this isolated process. No worker or real
   harness turn is needed for a schema capture.

3. Build the retained contracts using the pinned pnpm, then start the actual
   baseline `apps/api/src/server.ts` with that isolated environment. The source
   `dev` command is `node --import tsx src/server.ts`. Wait for the real
   `/health/ready` response to succeed. TS startup calls both
   `database.migrate()` and `checkpoints.setup()`. The latter belongs to the
   pinned LangGraph package and must execute; do not invent its SQL.

4. Keep only the initial state actually established by this TS setup. The
   server does **not** call `ensureAcceptanceSeed` from `seed.ts`. That optional
   fixture adds workspace-1, three agents/configurations, and
   workflow-content-pipeline/v1. Run it only if the controller/Q-CONF's matching
   TS setup also does so. Do not add those rows merely because the file exists.
   Preserve actual rows that migrations and selected startup/seed code insert,
   including the original `application_migrations` rows,
   `application_installation` singleton, and local-human principal records.
   Inspect startup-created settings and operator rows instead of guessing them.

5. Stop only the TS process owned by this capture and wait for its clean
   shutdown. Query the actual `public.application_migrations` version set and
   compare it with `assets/expected-head.json`: all 183 source-derived versions
   must be present, including final version 2026101702, and no unknown versions.
   Record actual schema inventory and row counts as capture evidence. Preserve
   the configured `LANGGRAPH_CHECKPOINT_SCHEMA` (default `langgraph`).

6. Dump that stopped, fresh database with a compatible `pg_dump`. Use a plain,
   UTF-8, data-inclusive dump with INSERTs, not COPY input, and without ownership
   or ACL commands. The relevant flags are:

   ```sh
   pg_dump --format=plain --inserts --encoding=UTF8 --no-owner --no-privileges \
     --file="$SCHEMA_CAPTURE_RAW_SQL" "$SCHEMA_CAPTURE_DATABASE_URL"
   ```

   The controller supplies both task-specific variables from its isolated
   resource setup. Do not include `--schema-only`, `--clean`, `--create`, or
   credentials/environment files in the patch. The entire dump must come from
   this actual database; never concatenate TypeScript migration strings.

## Make the actual dump executable by pgx

Keep the original dump outside the repository and record its real SHA-256.
`pg_dump` output can contain psql client commands such as `\restrict` and
`\unrestrict`; pgx executes SQL and cannot execute those client commands.
Remove only observed, identified client directives in a deterministic conversion
and record exactly what changed. An unexpected client command requires review.

Inspect whether the actual dump emits `CREATE SCHEMA public;`. A fresh database
normally already contains that empty schema. Resolve that observed restore
conflict in the conversion, document the exact change, and verify the result on
a second fresh database. Do not assume raw pg_dump output is directly executable
and do not silently rewrite domain tables, defaults, constraints, or seed rows.

Save the verified, SQL-only result as `assets/baseline.sql`. Record its actual
SHA-256, the raw dump SHA-256, source SHA, PostgreSQL server/client versions, Node
and pinned pnpm versions, configured checkpoint schema, capture timestamp, and
actual migration/seed row counts in a concise capture provenance JSON file.
Review the real output for credentials and unrelated runtime data before adding
it; evidence containing secrets, raw environment files, caches, or process logs
stays out of the patch. Never claim the source metadata is executed evidence.

The schema package uses the SQL dump only when the database is empty. It never
replays TypeScript migrations. The dump must restore `application_migrations`
itself, with its real rows; the package rechecks those rows after executing it.
New Go changes use their own `schema_migrations` table and never replace the TS
ledger with a claimed current marker.

## Required execution checks

Use another newly created database for every destructive variation, random
ports, and isolated state. Root composition must supply the separate migration
pool (one connection, a 30-minute client query timeout and five-second lock
timeout), not the normal one-second request pool.

- Restore through the real `schema.Prepare` path on an empty DB. Verify the
  actual schema and migration/seed rows, then call Prepare again to prove
  idempotent acceptance.
- Start against the actual TS-migrated database and prove acceptance without
  changing its application migration history or existing records.
- Reject a nonempty unknown database, an older history, a missing interior
  migration despite the same maximum, and an unknown newer version.
- Reject unavailable checkpoint tables. Readiness must execute the same query
  as TS against `checkpoints`, `checkpoint_blobs`, and `checkpoint_writes` in
  the configured schema; empty tables are successful. A plain `SELECT 1` is
  insufficient.
- Exercise one later numbered migration through public database behavior:
  apply once, retain its persisted result on restart, and reject a changed,
  missing, or unknown recorded migration. Check rollback on failed application.
- Run the controller's full fork CI round and Q-CONF's SKEL scenarios on the
  reviewed exact head. Record real tickets/counts before claiming the first
  skeleton merge gate passed. The unit fixtures here do not replace those checks.

Remove completed temporary databases, owned processes, capture state and
worktrees after evidence and reviewed changes are safely retained. Never clean
up resources belonging to the deployed app or another owner.
