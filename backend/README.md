# Shared Go runtime

This module supplies the common server, database, command, and registration
boundaries used by the Go backend. The frozen TypeScript behavior remains in
`apps/api`; shared domain contracts remain in `packages/contracts`.

## Commands

The single `foreman` binary dispatches `serve` and `worker`, together with
`guardian`, `mcp-launcher`, `rsync-writer`, `refresh-job-runtime`,
`capture-job-runtime`, and `format-helper`. `foreman --help` lists them without
opening a database or port. `serve` loads the selected product env file (or
`.env`) and resolves process/file aliases before reading its settings. Worker and
helper entrypoints explicitly report that they are unavailable until their
owning domain supplies an implementation.

## Register a domain

Create a focused package under `internal/<domain>` with `Register(*app.App)`.
Add one call to `registerDomains` in `cmd/foreman/main.go`. The integrator owns
that composition file.

The app provides these registration methods:

| Method | Purpose |
| --- | --- |
| `Handle` | An HTTP route that returns failures to the common error boundary. |
| `RegisterTool` | An MCP tool, its generated input validator, and its handler. |
| `RegisterStream` | A streaming route with the same transport error boundary. |
| `RegisterService` | A named background service tied to the server lifetime. |

Use generated contract schemas and types for domain data. The JSON Schema
export/type generation pipeline is a later shared-foundation slice; do not
fill that gap with hand-copied domain structs. Protocol envelopes are currently
constructed directly by their shared transport implementations.

`App.Config`, `App.Database`, and `App.Logger` are available during registration.
Construct domain services there. Services passed to `RegisterService` must
respect cancellation and return failures. Compose all registrations before
calling `App.Serve`.

MCP tools authenticate before request bodies are consumed, filter discovery
through the access implementation, and authorize every invocation. A missing
access implementation does not expose tools. The concrete access service is
part of the remaining foundations; the command currently leaves MCP closed.

## Database ownership

Use `database.WithTransaction` for transactional work. It owns transaction
control, rollback, connection release, conflict retries, and timing. Repositories
receive the `database.Querier` interface. Do not add another transaction helper.

`database.WithReadRetry` scopes the single retry for acquiring a connection.
`database.RetryTimeout` and `database.RetryOperation` are only for replay-safe
database bookkeeping. They must never wrap a native provider submission.

Startup uses a separate migration pool with a 30-minute query limit and a
5-second lock limit. Its replay-safe schema preparation uses the shared startup
retry policy. Ordinary requests retain the configured shorter limits.
Readiness checks the database and the actual configured checkpoint tables.

## Captured schema baseline

`internal/schema` accepts the complete TypeScript migration history or restores
an empty database from an actual embedded dump. Unknown histories are rejected.
Later numbered SQL migrations have their own checked ledger.

Fresh startup requires `assets/baseline.sql`, captured by the controller through
Foreman CI. Without that actual dump, empty-database startup fails with an
explicit missing-baseline error. The expected-head asset is source-derived
metadata, not evidence that a database was migrated. Follow the schema package's
capture instructions and verify the actual dump before enabling fresh startup.

## Verification

The Go toolchain and direct modules are pinned in `go.mod`. Their releases were
checked against the 48-hour age policy. The committed module graph and `go.sum`
come from the controller's real Foreman CI module-resolution capture.

Run formatting, build, vet, and all tests only through Foreman CI on the exact
reviewed head. Use the repository-pinned pnpm for retained TypeScript work.
CI tooling and conformance expectations have separate owners; the controller
captures the real SQL baseline and formatting artifacts separately.

The CI integration phase selects tests with the `integration` build tag. These
tests require `FOREMAN_CODE_CI_TEST_ADMIN_URL`, which the CI database prerequisite
exports for its freshly provisioned PostgreSQL instance. They do not fall back
to an application `DATABASE_URL`. The shared `internal/testdb` fixture creates
a unique empty database for each test and drops only that owned database after
its connections close. CI owns the PostgreSQL instance, random port, and
isolated HOME/state. The Go tests do not start or stop that instance.

The tagged tests verify transaction commit, rollback and cancellation by
persisted readback; schema startup, restart and migration-history rejection
against the actual captured baseline; and readiness and error responses over
a real loopback HTTP listener backed by PostgreSQL. Missing disposable-resource
configuration or a missing baseline fails the relevant tests instead of
skipping them. Ordinary unit tests do not provide this database evidence.

Keep the first skeleton draft until the controller reports the required full
CI and conformance gate on its exact head. Later foundations include contract
generation and validation, canonical JSON, access middleware, static files,
body-limit parity, rotating logs, and browser stream/WebSocket helpers.
