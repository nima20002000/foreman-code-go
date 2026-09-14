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
