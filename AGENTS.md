# Repository instructions

## Scope

This repository currently contains only the React web shell in `apps/web` and
the shared contracts package in `packages/contracts`. The initial product is a
wireframe and interaction foundation: do not add a backend, task execution,
GraphQL transport, persistence, or real external integrations as part of the
shell work.

Keep feature work behind the shared contracts package. The web app should not
redefine API/domain shapes locally or import server-only code.

## State and data ownership

- TanStack Query owns server state and request lifecycle state.
- Zustand owns local interaction state that is not shareable through the URL.
- The URL owns navigation, selected views, filters, and other linkable state.
- HTTP access must remain behind a small client boundary so MSW can provide
  deterministic request handlers in tests and during the wireframe phase.

Do not duplicate one state source in another layer without a documented reason.

## Verification

From the repository root, use the pinned pnpm runtime and run:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Keep generated output, local environment files, caches, and credentials out of
Git. Make focused changes and preserve unrelated worktree edits.
