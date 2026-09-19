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
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm build
```

`corepack pnpm dev` starts the local stack: it creates `apps/api/.env` from the
example if missing, starts and waits for the Compose PostgreSQL service, builds
and watches contracts, then starts the API and Vite. It verifies the API and web
addresses before reporting them. If either server is already running, it reuses
that server; an unrelated process on either port is reported as a conflict.
Ctrl-C stops only the processes started by this command. PostgreSQL stays up.
For individual processes, use `corepack pnpm dev:api` or
`corepack pnpm dev:web` after `corepack pnpm db:up`.

The API port is `PORT` in `apps/api/.env` (3000 in the example, also the config
default). Vite uses port 5173 and proxies `/api` to the API. The startup command
passes the configured API port to Vite. The API and Vite run on the host; Docker
Compose runs only PostgreSQL, bound to `127.0.0.1:5432`. Its named volume keeps
application records and LangGraph checkpoints across `db:down` and restarts.
The API applies database migrations during startup.

The real API requires browser access. Configure the private auth values in
`apps/api/.env` as described in [`docs/browser-auth.md`](./docs/browser-auth.md),
complete the one-time owner setup at `/setup`, then sign in. The Account link
beside the theme control opens your profile and sign-out controls. Startup never
creates an owner or grants access implicitly.

For a separate local test installation, set `GRAPHQL_API_ENV_FILE` to an absolute
path before `corepack pnpm dev`; the API and credential CLI use that file instead
of `apps/api/.env`.

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

The combined `dev` command uses the real backend through Vite's `/api` proxy.
The standalone `dev:web` command can still run with browser fixtures in the
checked-in web app; set `VITE_ENABLE_MSW=false` to use the real API there too.
MSW also remains in the test harness. Configure an existing runner directory in Workspace
Settings before Start. The Website workspace, saved workflow graph, Start action,
and run status/result reads use the real backend.
See [`docs/ENG-02-real-workflow-engine.md`](./docs/ENG-02-real-workflow-engine.md)
for the qualified harness contract and acceptance workflow.

The interface starts in dark mode. Use the workspace-header theme button to
switch to light mode; the explicit choice is stored locally and restored before
the next paint. Theme preference is client interaction state, not API or URL
state.
