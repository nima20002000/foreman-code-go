# `@graphql/api`

This package is the ENG-01 backend foundation. It owns process composition and
real infrastructure but does not yet implement product persistence or agent
execution.

## Runtime boundaries

- `src/app.ts` builds the Fastify HTTP application without opening sockets or
  infrastructure connections, which keeps route tests deterministic.
- `src/server.ts` is the composition root. It loads configuration, connects
  PostgreSQL, initializes LangGraph's PostgreSQL checkpointer, then listens.
- `src/infrastructure/database.ts` owns the application `pg` pool.
- `src/infrastructure/checkpoints.ts` owns `PostgresSaver`; its `saver`
  property is the checkpointer ENG-04 passes to compiled LangGraph workflows.
- `src/modules/workflows/port.ts` is the ENG-02 workflow-version persistence
  boundary.
- `src/modules/harnesses/port.ts` is the ENG-03 native-session adapter
  boundary.
- `src/modules/runs/port.ts` is the run persistence and ENG-04 orchestration
  boundary.
- `src/modules/activity/port.ts` is the ENG-05 activity persistence/streaming
  boundary.

Only `/health/live` and `/health/ready` are registered today. Returning 404 for
the frontend product routes is intentional; MSW remains the product data source
until ENG-02 adds real repositories and handlers.

## Local run

From the repository root:

```sh
pnpm db:up
cp apps/api/.env.example apps/api/.env
pnpm dev:api
curl http://127.0.0.1:3000/health/ready
```

Stop PostgreSQL with `pnpm db:down`. Add `-v` manually only when you explicitly
want to delete the local database volume.

## Production build and regression checks

```sh
pnpm build
pnpm --filter @graphql/api start
# In a separate shell, against the test database:
pnpm test:integration
pnpm test:production
```

The contracts package builds JavaScript and declarations into `dist` before
its consumers build. Production starts plain `node dist/server.js`; no `tsx`
or native TypeScript stripping is required. The optional local `.env` file is
loaded by the composition root on both development and production paths. Root
development commands also watch/rebuild contracts, and root validation commands
build contracts before checking consumers.

Both PostgreSQL pools handle and log idle-client errors. Readiness checks the
application pool and actual checkpoint tables through the saver's own pool.
`READINESS_TIMEOUT_MS` defaults to 2000. Each dependency has at most one in-flight
probe; callers share it until the underlying operation has finished cleanup.
On a readiness deadline, an active probe connection is destroyed. An acquisition
already waiting for a pool slot is bounded by `DATABASE_CONNECTION_TIMEOUT_MS`
and its eventual lease is discarded without querying. Both pools also enforce
`DATABASE_QUERY_TIMEOUT_MS` (default 1000) as a client query timeout and a server
statement timeout. Configure these bounds for the intended workload.

CI builds/checks with Node 22.16.0 and runs the compiled production command on
both Node 22.16.0 and the declared Node 22.0.0 runtime baseline. It also runs
`node scripts/production-smoke.mjs --restart-postgres` to stop and restart the
repository's Compose PostgreSQL service while the same API process is alive.
This disruptive restart test is opt-in; the normal production smoke command
does not stop PostgreSQL. Use only a dedicated test database for integration tests.
