# `@graphql/contracts`

The contracts package is the neutral Phase 1 boundary shared by the UI and API.
It contains Zod schemas and inferred TypeScript types for workspace details,
agents, workflow definitions, conversations, messages, run/resource summaries,
API errors, endpoint payloads, and URL scenario selection.

The package deliberately keeps three concepts separate:

- a workflow node references an Agent through `agentId`; it is not an embedded Agent;
- a Conversation is scoped to its owning Agent through required `agentId` (including
  the Operator conversation);
- `executionState` and `outcome` describe different aspects of a run;
- browser wait reason, resource identity/name, holder identity/label, and optional
  execution identity are explicit fields rather than only a holder-kind enum;
- `authRequired` and runner health are explicit fields rather than overloaded outcome/status values.

Agent projections can independently expose `executionState` (and the matching
`status` vocabulary) as `available`, `working`, `waiting_browser`,
`auth_required`, `interrupted`, or `disconnected`. They may also include a
`role` and `harnessSummary` for the context panel. `activeRunId` is the
neutral link from that logical Agent projection to its current `RunSummary`;
browser wait, resource, and runner facts stay on the run projection and are
not encoded in harness metadata.

Import the public surface from `@graphql/contracts` (or `src/index.ts` in local
workspace tooling). No React, persistence, transport, or runner implementation
belongs here.
