# graphql

`graphql` is a pnpm TypeScript monorepo for an agent workspace. The project
name is `graphql`; it is not a GraphQL protocol or query-engine implementation.
The frontend remains a wireframe-first product surface backed by MSW. ENG-01
adds the first real backend foundation without yet replacing those product
mocks.

## Workspace

- `apps/web` — React/Vite shell, providers, test harness, and browser smoke test
- `apps/api` — Fastify process, PostgreSQL connectivity, LangGraph PostgreSQL
  checkpoint storage, and backend extension ports
- `packages/contracts` — shared, runtime-validated domain and API contracts

See [`AGENTS.md`](./AGENTS.md) for state ownership and scope rules.

For the NIM-2576 owner walkthrough, route/API/schema inventory, mock scenario
semantics, UX decisions, backend handoff boundary, and verification record, see
[`docs/NIM-2576-handoff.md`](./docs/NIM-2576-handoff.md).

## Commands

```sh
pnpm install
pnpm dev
pnpm db:up
cp apps/api/.env.example apps/api/.env
pnpm dev:api
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

`GET /health/live` reports process liveness. `GET /health/ready` checks both
the application PostgreSQL pool and the LangGraph checkpoint saver. The API
fails startup if either dependency cannot initialize.

`pnpm test:integration` requires the PostgreSQL service. It writes a real
LangGraph checkpoint, closes the saver, reopens it, and proves the checkpoint
is durable. `pnpm db:down` stops the local service without deleting its named
volume.

The checked-in browser mock starts by default during development so the
wireframe shell always has deterministic data. It runs only together with
Vite's development flag and is never a production fallback; a real backend must
provide the HTTP boundary when the app is built or deployed.

Set `VITE_ENABLE_MSW=false` to disable the mocks when running Vite against a
real API:

```sh
VITE_ENABLE_MSW=false pnpm dev
```

The ENG-01 API intentionally does not implement the frontend's workspace,
workflow, conversation, or resource routes. Those remain MSW-backed until the
corresponding persistence/API workstream lands. See
[`docs/ENG-01-backend-foundation.md`](./docs/ENG-01-backend-foundation.md) for
the real/mocked boundary and the extension interfaces.

The interface starts in dark mode. Use the workspace-header theme button to
switch to light mode; the explicit choice is stored locally and restored before
the next paint. Theme preference is client interaction state, not API or URL
state.
