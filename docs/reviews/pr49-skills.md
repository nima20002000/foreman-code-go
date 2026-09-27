# PR #49 Skills review and verification

## Review authority and scope

On 2026-09-27 the owner replaced the planned two GPT Web Pro reviewers with one local
GPT-5.6 Sol reviewer at medium reasoning. `/root/skills_review` inspected head
`34599c26280fa47f395c1da739e14ad28edd4151` against
`06fa976e21cda6d967ce5d6b7bee1a733090f96a`, read-only. No second local review pass was run. The earlier Web request was superseded and is not counted as review evidence.
The three findings below were verified locally and fixed in the corrective commit containing this report.

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| High: archive/restore returned existing instructions to publish-only callers | Require workspace `skills:read` as well as `skills:publish`; document the MCP requirement | Authenticated HTTP and MCP publish-only calls are denied, do not return the body, and leave revisions/archive state/version counts unchanged |
| High: changing only Operator harness/thinking settings republished skills without source permission | Check each assigned workspace whenever Operator settings cause republication | Same-reference settings changes fail through HTTP/MCP without source access, preserve settings and configuration counts, and succeed for an authorized caller |
| Medium: Operator rejected equal historical skill IDs in separate workspaces | Deduplicate by workspace/skill tuple and retain workspace identity in new Operator snapshots | Two workspace-owned `legacy-shared@1` skills save and compose in order; cross-workspace snapshot swaps fail integrity checks |

Previously accepted snapshots remain readable; the added workspace field is optional for those
historical snapshots. Newly resolved Operator snapshots always include it. No stored Run or
WorkflowVersion was rewritten.

## Fresh automated evidence

Commands use `corepack pnpm` in the Skills worktree. PostgreSQL is a separate Compose project
`graphql-skills-review`, PostgreSQL 17 on loopback port 55439. The shared development database
was not stopped or reset. Logs are local `/tmp/graphql-skills-review-*.log` artifacts, not tracked.

- `corepack pnpm install`: passed, lockfile unchanged.
- `corepack pnpm build`: passed; measured Codex 0.154.0 and OpenCode 1.18.31.
- Web `typecheck` (`tsc -b`): passed.
- Root typecheck stops at four contracts test diagnostics. Direct API typecheck reports 260
  diagnostics. Both match main's diagnostic locations/codes; no candidate source errors were added.
- Root lint stops at six contracts errors. Direct API lint has 30 errors; direct web lint has
  3 errors and 11 warnings. Diagnostics match main in each package.
- Root `test`: contracts 306 passed; API 2,386 passed, 26 skipped. Web source smoke fails the
  same pre-existing assertion at `currentSource.smoke.mjs:49` on both trees.
- Direct web Vitest: 1,160 passed, two 5-second timeouts. Rerunning the two files together with
  one worker passed all 31 tests. Skills UI tests passed all 16 tests.
- Final focused PostgreSQL/MCP, composer and both adapter suites: 69 passed across four files.
  The PostgreSQL/MCP plus composer subset passed 15 tests. Tests include authenticated
  denied callers and persisted readback, not only mocks.
- `RUN_SKILLS_NATIVE=1 ... vitest run test/skills-native.acceptance.test.ts`: 4 passed.
  Both installed harnesses received the marker skills, a concurrent no-skill control did not,
  later turns and exact-session attach after manager restart retained the instructions, and
  Operator sessions received the skills. Codex 0.156.1 was not installed or claimed qualified.
- Broad PostgreSQL integration/acceptance comparison: pending final results below.

## Live browser evidence

Built-in computer-use operated the candidate at `http://127.0.0.1:5194`, API port 3094, with
its own `graphql_skills_live` database. No MSW browser interception was used.

Created workspace `workspace-5ac024b8-1727-4887-b7ec-d7c6b7bcdee6`, then created and reloaded a
Unicode-named skill, saved a second immutable version, archived and restored it, and created a
second skill. The Board picker selected both, reordered them, applied settings, and saved through
the canonical workflow path. Initial save correctly required an approval handler and finite
execution bounds. The saved worker remained read-only with human approval routing.

Workflow `workflow-ba582798-80bf-4f89-83eb-467900a6f9bf` produced:

| Run | Saved skill behavior | Actual accepted result |
| --- | --- | --- |
| `run-521be402-3c9f-419a-b0e9-372c1dac01d9` | Prefix v2, suffix v1 | `CEDAR-927 hello MAPLE-927` |
| `run-6261336b-9c81-4714-94b9-db4380ebde07` | Catalog prefix changed to v3; saved Board remained v2 | `CEDAR-927 hello MAPLE-927` |
| `run-15248ad1-b20d-48e2-a5c0-297561363e15` | Explicit "Use version 3", Apply, Save and run | `SEQUOIA-927 hello MAPLE-927` |

Two initial runs failed MCP preflight before the test profile was configured for this API.
The normal profile had no `graphql` entry; Agent 2's existing task profile referenced a launcher
under its former isolated home. The task profile's existing connection was corrected to this API
with the standard scoped bearer environment variable. Preflight, native sandbox and grants were
not bypassed. Native credentials were not copied or printed.

At 390 × 844 the Skills editor remained usable with document width 375 (no horizontal overflow);
the temporary viewport override was reset afterward. Exact immutable versions and accepted Run
outputs were inspected through the live app.

## Delivery status

Corrective source and feature-specific acceptance are complete. Broad-suite failure comparison,
remote publication and the merge decision are still pending. No merge or post-merge smoke is
claimed by this report.
