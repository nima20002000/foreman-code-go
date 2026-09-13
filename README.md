# graphql

`graphql` is a small pnpm TypeScript monorepo for a wireframe-first agent
workspace shell. The project name is `graphql`; it is not a GraphQL protocol,
server, query engine, or external integration. The first milestone establishes
the web shell and shared contracts and intentionally does not include a
backend, execution engine, or persistence.

## Workspace

- `apps/web` — React/Vite shell, providers, test harness, and browser smoke test
- `packages/contracts` — shared, runtime-validated domain and API contracts

See [`AGENTS.md`](./AGENTS.md) for state ownership and scope rules.

For the NIM-2576 owner walkthrough, route/API/schema inventory, mock scenario
semantics, UX decisions, backend handoff boundary, and verification record, see
[`docs/NIM-2576-handoff.md`](./docs/NIM-2576-handoff.md).

## Commands

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

The checked-in browser mock is opt-in during development. Start Vite with
`VITE_ENABLE_MSW=true`:

```sh
VITE_ENABLE_MSW=true pnpm dev
```

`VITE_ENABLE_MSW=true` is checked together with Vite's development flag. It is
not a production fallback; a real backend must provide the HTTP boundary when
the app is built or deployed.

The interface starts in dark mode. Use the workspace-header theme button to
switch to light mode; the explicit choice is stored locally and restored before
the next paint. Theme preference is client interaction state, not API or URL
state.
