# Repository instructions

## Scope

This repository contains the React web shell in `apps/web`, the shared
contracts package in `packages/contracts`, and the ENG-01 Fastify/PostgreSQL
foundation in `apps/api`. The frontend product flow is still a wireframe and
interaction foundation: do not add task execution, GraphQL transport, product
persistence, or real external integrations unless the current workstream
explicitly authorizes them.

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
pnpm db:up
pnpm test:integration
pnpm db:down
```

Keep generated output, local environment files, caches, and credentials out of
Git. Make focused changes and preserve unrelated worktree edits.

======
## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

PROJECT RULE: YOU ARE NOT ALLOWED TO CHANGE SSH/VPS SECURITY/ ROUTER SETTINGS UNLESS I SPECIFICALLY GIVE YOU PERMISSION FOR THE JOB YOU WANT TO DO

PROJECT RULE: DO NOT USE LINEAR OR CREATE, UPDATE, OR COMMENT ON LINEAR ISSUES UNLESS THE USER SPECIFICALLY ASKS YOU TO USE LINEAR FOR THE CURRENT TASK.
