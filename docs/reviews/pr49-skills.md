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
- Root `test:acceptance`: the same four setup failures on candidate and main (missing native
  capture/proof composition; legacy ENG-03 matrix database setup). This is not a passing suite;
  the four passing Skills-native scenarios above are separate evidence.
- An additional all-suite `RUN_WAVE25_POSTGRES_TESTS=1` sweep was interrupted on both trees
  after unrelated recovery failures and long timeouts. It is not claimed as completed or passing.
  The documented integration command is being compared on fresh isolated databases without that
  optional repository-wide gate; the Skills PostgreSQL suite was separately enabled and passed.

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
the temporary viewport override was reset afterward. A two-editor conflict preserved unsaved text,
showed the competing revision, and loaded it only after explicit discard; navigation also showed the
unsaved-change guard. Exact immutable versions and accepted Run outputs were inspected through the live app.

## Delivery status

Corrective source and feature-specific acceptance are complete and published as `0f33bd1`.
The documented integration-suite comparison and merge decision remain pending. No merge or post-merge smoke is
claimed by this report.

## Later integration repair (uncommitted)

Three GPT-6 Sol agents at medium effort split the stale API test suites. The
starting check had 234 API test type errors and eight lint errors (seven API,
one web). Current root `typecheck`, `lint`, `test`, and `build` pass. Root test
counts are 306 contracts, 2,386 API (15 skipped), and 1,162 web. Two long
Board interactions use a 15-second test timeout because they exceeded the
default five seconds only under the full parallel web run.

The documented `test:integration` command passed 28 files and 116 tests;
59 files and 450 tests were skipped by optional gates. With the PostgreSQL
gate enabled, the current approval orchestration and atomic publication suites
passed 18/18. Focused PR17 native event allocation, production User approval,
worker credential, workspace archive, and launcher suites also passed. The
old App MCP fixture fabricated a reviewer and native state that V3 refuses;
current authenticated MCP decision coverage remains in the passing approval
orchestration suite. Other retired suites depended on removed execution
semantics or raw one-shot/graph writers. The old A5 graph-read suite was also
run against PostgreSQL: its legacy publications could not advance the V3
reader, so it and its unused fixture were retired.

Two app issues were fixed: exact approval retries can read a completed Run
while live principal checks still apply, and a pending decision checks caller
scope and continuation authority before it can commit. A second continuation
check after attachment prevents a known-invalid native response from entering
the delivery write. New migration `267202` requires a same-transaction graph
source for V3 interaction and review writes; the focused raw-writer regression
and normal approval writers both passed.

`test:acceptance` now targets the current ENG-03 C native suite and defaults
to the pinned Codex 0.154.0 binary. With a task-owned loopback test database,
its seven cases failed before the first native turn with
`APP_MCP_PREFLIGHT_FAILED`: the active Codex profile lists `graphql-app` and
`graphql-operator`, but no required `graphql` entry. The initial run also
selected the machine's unqualified Codex 0.157.1; a rerun with pinned 0.154.0
confirmed the MCP preflight blocker. No paid native acceptance result is
claimed. The retired acceptance suite's exact Codex → OpenCode → Codex chain
has not been re-established on V3. This repair is on the PR #49 branch;
the PR remains open and unmerged.
