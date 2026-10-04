# graphql

`graphql` is a pnpm TypeScript monorepo for an agent workspace. The project
name is `graphql`; it is not a GraphQL protocol or query-engine implementation.
The browser uses the real local backend; MSW fixtures run only in unit tests.
The backend persists saved workflow versions and runs, then
uses LangGraph to coordinate native Codex and OpenCode headless sessions.

## Workspace

- `apps/web` — React/Vite shell, providers, test harness, and browser smoke test
- `apps/api` — Fastify process, PostgreSQL connectivity, LangGraph PostgreSQL
  checkpoint storage, and backend extension ports
- `packages/contracts` — shared, runtime-validated domain and API contracts

See [`AGENTS.md`](./AGENTS.md) for state ownership and scope rules.

For a persistent desktop installation from a production build, see
[`docs/local-production.md`](./docs/local-production.md).

The authenticated local Operator Management MCP is documented in
[`docs/operator-mcp-v1.md`](./docs/operator-mcp-v1.md). Operator chat and
workflow agents share one role-scoped GraphQL MCP connection; see
[`docs/graphql-mcp.md`](./docs/graphql-mcp.md).
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
corepack pnpm lines
```

Test, typecheck, lint, and build scripts share one visible FIFO slot across
linked worktrees. Waiting commands print their ticket; dev servers do not hold
the slot. Builds skip only when tracked and untracked inputs plus local outputs
match a successful build in that same worktree. Vitest's coordinator setup also
queues direct `pnpm exec vitest` runs that load a package config. A direct
compiler invocation bypasses the script queue; use the package scripts when
running these jobs alongside other worktrees. The API build always runs its
harness compatibility check. Integration has a 150-minute
limit and stops its process group before releasing the slot. Each job owns a
temporary directory and removes it on exit; only marked, unused directories
older than ten minutes are eligible for stale cleanup.

`corepack pnpm lines` counts physical lines in tracked code files, including
blank lines and comments. It reports source code, default/integration/acceptance/
smoke test files, test helpers and fixtures, and tooling separately. Test types
follow filenames; "default" means other `.test`/`.spec` files and does not
assert that every one is a unit test. The report does not imply that every
smoke file runs in CI.
Docs, JSON configuration, lockfiles, and generated files are excluded.

`corepack pnpm dev` starts the local stack: it creates `apps/api/.env` from the
example if missing, starts and waits for the Compose PostgreSQL service, builds
and watches contracts, then starts the API and Vite. It verifies the API and web
addresses before reporting them. It reuses an API only when that API already has
local development browser access; otherwise it reports a conflict. It reuses a
matching Vite server. An unrelated process on either port is reported as a conflict.
Ctrl-C stops only the processes started by this command. PostgreSQL stays up.
For individual processes, use `corepack pnpm dev:api` or
`corepack pnpm dev:web` after `corepack pnpm db:up`.

## API logs

The API writes one JSON object per line through pino
(`apps/api/src/infrastructure/logger.ts`). Every line has `level`, `time`,
`service`, `pid` and a `component`: `lifecycle`, `http` (requests and MCP),
`engine`, `harness` or `db`. HTTP lines carry a `reqId`. Tokens, credentials, cookies, prompts
and harness input/output are redacted.

- `LOG_LEVEL`: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace` or
  `silent`. Unit tests default to `silent`.
- `LOG_DIR` or `LOG_FILE`: also write to a rotating file (`api.<n>.log` plus a
  `current.log` link), rolled daily or at `LOG_MAX_SIZE` (default `20m`).
  `corepack pnpm dev` sets `LOG_DIR=.logs` unless you choose a destination.
- Retention: at most `LOG_MAX_FILES` files (default 14) and nothing older than
  `LOG_RETENTION_DAYS` (default 14). Enforced at startup and on every roll,
  including files left by earlier runs, so disk use stays bounded
  (about 14 × 20 MB by default). Other files in the directory are never touched.

Requests log one `request completed` line: `debug` for routine success,
`info` for 4xx, `warn` for anything slower than 2 s, `error` for 5xx. Paths are
logged without query strings. Set `LOG_LEVEL=debug` to see every request.

Nothing ends silently: startup, readiness, shutdown signals, stop, uncaught
exceptions, unhandled rejections, failed startup and every process exit are
logged (fatal lines are written synchronously before exit), as are PostgreSQL
pool errors, reconciliation failures and each Codex/OpenCode process start and
exit code. Only SIGKILL and the kernel OOM killer cannot be caught; a log that
stops without a final `process exiting` line points to one of those.

The API port is `PORT` in `apps/api/.env` (3000 in the example, also the config
default). Vite uses port 5173 and proxies `/api` to the API. The startup command
passes the configured API port to Vite. The API and Vite run on the host; Docker
Compose runs only PostgreSQL, bound to `127.0.0.1:5432`. Its named volume keeps
application records and LangGraph checkpoints across `db:down` and restarts.
The API applies database migrations during startup.

`corepack pnpm dev` enables local browser access on the loopback API. Open
`http://127.0.0.1:5173` without setting up or entering browser credentials.
The API still reads the chosen Operator's current grants for every request. It
uses the configured `GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID`, the browser owner, or a
single active root Operator in that order. An empty local database gets a durable
`principal-local-development-browser` Operator with app-wide grants. If several
eligible Operators exist without a browser owner, set
`GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID` in the private env file to select one. Existing
grants are never expanded. The local access stays active while the dev server runs,
so the Account page does not offer sign-out in this mode.
To configure password sign-in later on that fresh database, select
`principal-local-development-browser` as `OWNER_OPERATOR_PRINCIPAL_ID` during
the normal one-time owner setup.

Direct `dev:api` and production starts require normal browser authentication.
Configure private auth values and owner setup as described in
[`docs/browser-auth.md`](./docs/browser-auth.md). Local development browser access
is rejected when the API or database is not loopback or when `NODE_ENV=production`.

For a separate local test installation, set `GRAPHQL_API_ENV_FILE` to an absolute
path before `corepack pnpm dev`; the API and credential CLI use that file instead
of `apps/api/.env`.

Model selectors read the API host's qualified Codex or connected OpenCode native
catalog, including model-specific efforts and variants. The bundled Codex CLI is
0.154.0; an existing authenticated Codex 0.156.1 installation can be selected
with an absolute `CODEX_BINARY` path in the private API env file to expose its
newly advertised models. Both releases have separate protocol qualifications;
other CLI versions remain unavailable until qualified. OpenCode's explicit
models.dev update and the ordinary local catalog reread are separate actions.

The repository pins pnpm 11.27.0 and rejects plain `npm install`. pnpm enforces
a strict 2,880-minute (48-hour) minimum release age for direct and transitive
registry packages, with no exclusions and no missing-publish-time fallback.

`GET /health/live` reports process liveness. `GET /health/ready` checks both
the application PostgreSQL pool and the LangGraph checkpoint saver. The API
fails startup if either dependency cannot initialize.

`corepack pnpm test:integration` requires the PostgreSQL service. By default it creates
and removes disposable databases for parallel API suites, keeping the running app's settings
and data intact. See [the integration runner guide](docs/test-integration-runner.md) for
shard limits and failed-file retests. Set `TEST_DATABASE_URL` to explicitly supply a dedicated
test database and run serially. The startup suite writes a real
LangGraph checkpoint, closes the saver, reopens it, and proves the checkpoint
is durable. `corepack pnpm db:down` stops the local service without deleting its named
volume.

Both `dev` and standalone `dev:web` use the real backend through Vite's `/api`
proxy. MSW remains only in the unit-test harness. Configure an existing runner directory in Workspace
Settings before Start. The Website workspace, saved workflow graph, Start action,
and run status/result reads use the real backend.
See [`docs/ENG-02-real-workflow-engine.md`](./docs/ENG-02-real-workflow-engine.md)
for the qualified harness contract and acceptance workflow.

The interface starts in dark mode. Use the workspace-header theme button to
switch to light mode; the explicit choice is stored locally and restored before
the next paint. Theme preference is client interaction state, not API or URL
state.
