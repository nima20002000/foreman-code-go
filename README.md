# graphql

`graphql` is a pnpm TypeScript monorepo for an agent workspace. The project
name is `graphql`; it is not a GraphQL protocol or query-engine implementation.
The frontend can run either against deterministic MSW fixtures or the real
local backend. The real path persists saved workflow versions and runs, then
uses LangGraph to coordinate native Codex and OpenCode headless sessions.

## Workspace

- `apps/web` — React/Vite shell, providers, test harness, and browser smoke test
- `apps/api` — Fastify process, PostgreSQL connectivity, LangGraph PostgreSQL
  checkpoint storage, and backend extension ports
- `packages/contracts` — shared, runtime-validated domain and API contracts

See [`AGENTS.md`](./AGENTS.md) for state ownership and scope rules.

The authenticated local Operator Management MCP is documented in
[`docs/operator-mcp-v1.md`](./docs/operator-mcp-v1.md), with board-agent and
future Worker MCP access decisions in
[`docs/adr/operator-and-worker-mcp-access.md`](./docs/adr/operator-and-worker-mcp-access.md).
Workspace execution directories, immutable Run snapshots, and the boundary
between start location and isolation are documented in
[`docs/adr/workspace-execution-locations.md`](./docs/adr/workspace-execution-locations.md).

For the NIM-2576 owner walkthrough, route/API/schema inventory, mock scenario
semantics, UX decisions, backend handoff boundary, and verification record, see
[`docs/NIM-2576-handoff.md`](./docs/NIM-2576-handoff.md).

## Commands

```sh
corepack pnpm install
corepack pnpm dev
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm build
```

The repository pins pnpm 11.27.0 and rejects plain `npm install`. pnpm enforces
a strict 2,880-minute (48-hour) minimum release age for direct and transitive
registry packages, with no exclusions and no missing-publish-time fallback.

`GET /health/live` reports process liveness. `GET /health/ready` checks both
the application PostgreSQL pool and the LangGraph checkpoint saver. The API
fails startup if either dependency cannot initialize.

`corepack pnpm test:integration` requires the PostgreSQL service. It writes a real
LangGraph checkpoint, closes the saver, reopens it, and proves the checkpoint
is durable. `corepack pnpm db:down` stops the local service without deleting its named
volume.

The checked-in browser mock starts by default during development so the
wireframe shell always has deterministic data. It runs only together with
Vite's development flag and is never a production fallback; a real backend must
provide the HTTP boundary when the app is built or deployed.

Set `VITE_ENABLE_MSW=false` to disable the mocks when running Vite against a
real API:

```sh
VITE_ENABLE_MSW=false corepack pnpm dev
```

With MSW disabled, configure an existing runner directory in Workspace
Settings before Start. The Website workspace, saved workflow graph, Start action,
and run status/result reads use the real backend through Vite's `/api` proxy.
See [`docs/ENG-02-real-workflow-engine.md`](./docs/ENG-02-real-workflow-engine.md)
for the qualified harness contract and acceptance workflow.

The interface starts in dark mode. Use the workspace-header theme button to
switch to light mode; the explicit choice is stored locally and restored before
the next paint. Theme preference is client interaction state, not API or URL
state.
