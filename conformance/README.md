# Public conformance suite

This package is the Q-CONF implementation for [NIM-2932](https://linear.app/nima1999/issue/NIM-2932).
Its source baseline is `nima20002000/foreman-code-go` at
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. It drives an independently running
TypeScript or Go server through HTTP, authenticated MCP, browser streams, and
the worker pairing/WebSocket protocol. Shared domain schemas come from
`@foreman-code/contracts`.

The suite is under construction. Authored scenarios and coverage declarations
are not passing results. The complete TS selection must pass in a real controller
CI round before any lane relies on these expectations. Missing coverage makes a
complete selection fail even when its implemented scenarios pass.

## Controller CI integration

Execute tests only through Foreman CI MCP. Q-CI owns `scripts/ci-suite.sh` and
the CI configuration; this package does not modify them. The controller alone
publishes/configures the sanitized `nima20002000/foreman-code-go-ci` mirror.

The CI job needs the repository's pinned `pnpm@11.27.0`, the retained Node runtime,
built contracts, installed workspace dependencies, `git`, `openssl`, `ss`, Python 3 and
Linux `/proc`, and PostgreSQL server/client binaries available to an unprivileged
job user. The package keeps the repository's strict 48-hour dependency age policy.
It does not install software, change users, elevate permissions, or connect to
an existing PostgreSQL server. Q-CI supplies `CONFORMANCE_POSTGRES_BIN_DIR` as an
absolute directory containing `initdb`, `postgres`, `pg_isready`, `psql` and
`createdb`, all executable by the unprivileged job user. Without that setting,
`pg_config --bindir` selects the binaries. The setting selects binaries only;
the runner always creates its own cluster and database. Python's standard ZIP/XML
readers provide an independent DOCX output oracle; retained pinned `sharp` and
`unpdf` decode returned image/PDF bytes without importing server internals.

Use these commands inside the controller-dispatched CI job after its normal
dependency preparation:

```sh
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/conformance typecheck
corepack pnpm --filter @foreman-code/conformance lint
corepack pnpm --filter @foreman-code/conformance test
CONFORMANCE_TARGET=ts corepack pnpm --filter @foreman-code/conformance smoke
CONFORMANCE_TARGET=ts corepack pnpm --filter @foreman-code/conformance conformance
CONFORMANCE_TARGET=go corepack pnpm --filter @foreman-code/conformance conformance
```

The first smoke command is an incremental signal. It cannot establish full
coverage or satisfy the complete conformance issue. Full TS conformance is
required when expectations change. The Go command uses `backend/bin/foreman serve` by default;
`CONFORMANCE_GO_BINARY` may select the integrator's built binary. A missing binary
is reported as an unexecuted setup failure for every selected scenario.

CLI filters `--lane E,A1`, `--scenario workspace.create-replay-read`, `--smoke`,
and `--target ts|go` select a diagnostic run. `--list` emits the authored selection
without launching anything. Its coverage mapping records each requirement,
source provenance and declaring scenario IDs, plus missing requirements by
source family. This is authored metadata; live MCP remains explicitly not-run.
Filters never establish full-suite acceptance, and
empty selections always fail. `--output PATH` or `CONFORMANCE_RESULTS_FILE`
selects the result path.

The first-skeleton gate is separate from P1-ACCEPT: it requires full green Go CI
with nonzero actual test counts, plus a real passing Go SKEL selection:

```sh
CONFORMANCE_TARGET=go corepack pnpm --filter @foreman-code/conformance conformance --lane SKEL
```

Keep that result and the broader Go conformance result as separate CI artifacts.
Unimplemented/failed cases in other lanes remain failures in the full raw result;
they are not removed, skipped, or relabeled to satisfy the skeleton gate. 100% Go
conformance is the later P1-ACCEPT gate. A draft or authored inventory satisfies
neither gate; expectation reliance still requires the complete TS-target pass.

## Isolation and public setup

Each scenario gets a private temporary root, an initialized PostgreSQL cluster
and database, random loopback API/device/database ports, an empty API environment
file, and isolated HOME, Codex, Claude, XDG, storage, log and temporary directories.
The child environment contains an explicit small environment allowlist, not the
controller's installation state or credentials. The canonical
`resolveProductEnvironment` contract supplies product environment behavior.

Operator cases issue fresh manage and read-only credentials through the existing
administrative credential CLI before the API acquires its runtime lock. They
exercise existing permission presets. Scenario effects are read through HTTP/MCP,
never SQL. The only SQL in the launcher verifies that the fresh PostgreSQL process
owns the data directory it was created with.

The scripted Codex executable is selected through isolated PATH/settings. Its
optional adjacent native-file script handles declared dynamic file tools and
respects the supplied native sandbox. The fake Claude module exposes the official
SDK surface through `sdkEntrypoint`; the fixture README records the remaining
production discovery/qualification wiring needed from the harness owner.

The worker client generates fresh Ed25519 keys, obtains an existing pairing grant
from the fresh application, verifies the Main identity/challenge, and connects
with a fresh verified TLS trust root. Its application/remote-operation helpers
use shared contracts and placement bindings. An authored helper is not evidence
that a remote execution scenario has run.

The launcher stops its owned process groups and database before deleting its
marked private root. Linux native guardians can have separate process groups;
cleanup observes same-user process working directories under the owned root
through `/proc` and waits for their exit. Surviving processes or unavailable
ownership observations fail cleanup and retain the root for controller diagnosis.
The launcher does not signal arbitrary discovered processes. A cleanup failure is
retained as a failure and unsafe deletion is refused. Scenario assertion/setup failures do not omit later selected
scenarios. Restart scenarios retain only their own fresh database/state while
stopping and restarting their server.

## Results contract for Q-CI

The default result is `conformance/results/<target>.json`. Standard output emits
one JSON object per line with kind `conformance-scenario`, followed by
`conformance-summary`. Fatal configuration/identity errors emit
`conformance-startup-error` on standard error and fail the command.

The summary includes `schemaVersion: 1`, repository, exact baseline and tested
commit SHA, target, start/finish/duration, overall totals, all eight lane totals,
and every selected scenario outcome. Each outcome carries `status`, `phase`
(`setup`, `scenario`, or `cleanup`), and `executed`; a setup failure is not claimed
as executed. Aggregate failures retain their underlying causes. Zero scenarios
cannot pass, and duplicate scenario IDs fail instead of inflating counts.

`scope.completeSelection` distinguishes a full unfiltered run. `coverage.http`,
`coverage.mcp`, and `coverage.behaviors` include missing/unexpected requirements
and coverage totals; `coverage.complete` must be true for complete conformance/P1
acceptance. Live MCP
discovery reads every `tools/list` cursor page from a fresh running target. An
unavailable live catalog is reported as unavailable, never replaced with a
source-derived or invented catalog. `coverage.mcp.status` is `not-run` for a
filtered/smoke selection.

For a sanitized mirror, the controller may supply `CONFORMANCE_COMMIT_SHA` with
the exact corresponding fork SHA; `commitSource: environment` records that
provenance explicitly. Without it, the actual checked-out Git SHA is recorded.
`CONFORMANCE_BASELINE_SHA` cannot change the pinned baseline. Q-CI must retain
the actual CI tickets and this result JSON; authored scenario totals must never
be reported as pass counts.

### Watchdog progress

When Q-CI sets `CI_PROGRESS_FILE`, the runner appends JSONL through the existing
`scripts/ci-progress-reporter.mjs` writer. It preserves the watchdog convention:
`type: start|finish`, `kind: module|test`, `id`, repository-relative `file`, and
`name`. The shared writer prefixes each ID with its file. Extra fields identify
`target`, `phase`, and, for scenario work, the current `scenarioId` and `lane`.

Suite, setup, live MCP discovery and cleanup use module events. An actual
scenario uses test events and starts only after target setup succeeds. Its finish
event follows cleanup and contains the final status, including cleanup failures.
Cleanup finish reports `cleanupCompleted: true` only after owned processes stop
and the owned root is removed; a cleanup error reports false. If resource creation
fails before a cleanup observer exists, no cleanup completion is claimed.

This progress stream supplements the unchanged `schemaVersion: 1` result
contract and `CONFORMANCE_RESULTS_FILE`; it cannot substitute for complete raw
outcomes, coverage, lane totals or provenance. A progress-write error is retained
as optional `progressError`, fails the run, and leaves every scenario outcome in
the raw result. Progress output never changes an unimplemented failure into a
passing or skipped case.

## Expectations and required scope

Expectations compare complete bodies, status codes, and error codes. Only
individually named generated identifiers, timestamps, and durations may be
normalized. Public readback verifies persisted effects. No scenario parses
source code or queries private database state. Q-CONF reviews expectation changes,
and an actual TS-target pass is required before reliance.

The checked-in HTTP inventory includes explicit registrations, expanded route
loops, generated HEAD routes, optional web/device mounts, and separate native
file/worker MCP listeners. Transport is part of coverage identity. Each route
requires success plus error/denial. Every live Operator MCP tool requires success,
denied caller, and persisted readback. Each registered browser SSE route requires
framing, order, and reconnect cases.

The required workflow groups are ordinary execution, finite repeat,
handoff/join, interactions/resume, retry, Stop, interval, schedule, Jobs, and
kill/restart recovery. Required fixed-file codec groups are image resize/rotate,
animated GIF/WebP, PDF read/append, and DOCX read/edit. The coverage checker keeps
these requirements independent of the executable scenario registry.

### Authored checkpoint

The current reviewed registry contains 90 authored scenarios. These counts describe source
inventory only; no execution, TS/Go pass rate, or completed coverage is claimed.

| Group | Authored scenarios | Scope |
| --- | ---: | --- |
| Smoke | 24 | Three public scenarios for each of the eight lane tags |
| HTTP | 31 | Workspace/settings/workflow metadata, files and retention, skills, bug reports, protected-route denials, and Main root binding |
| MCP | 9 | Operator settings/conversations, workspaces, and paired-worker root configuration and directory readback |
| Operator SSE | 4 | Snapshot framing, actual native ordering, reconnect, and invalid credentials |
| Workflows | 13 | Ordinary execution, repeat early/limit exit, retry, Stop/new Start, interval checks, restart between settled checks, parallel join, work handoff, three native interaction/resume callers, and actual schedule admission |
| Codecs | 9 | Fixed image, PDF and DOCX inputs with public file operations, native tools, complete readback, and independently decoded output |

The Main root scenario adopts the installation's existing app-managed storage
configuration and binds a real owned directory read-only. The worker directory
scenario uses fresh pairing, TLS/WebSocket negotiation and actual filesystem
enumeration, then checks reconnect and Main restart. Neither adds approval or
grants, and directory operations do not establish installed-worker execution.

The native App MCP fixture connects through the accepted configured transport
and credentials. Public join, work-handoff, interaction/resume and scheduled-run
scenarios drive that real protocol and assert accepted results and persisted
readback. The workflow restart case kills Main between settled interval checks;
in-flight native recovery remains outstanding. Native Codex and native Claude
success remain independent required coverage gates; setup metadata cannot
discharge either gate.

The full HTTP inventory still contains 483 route/listener identities: 322 explicit mounts,
159 generated HEAD variants, and two runtime listeners. Each identity requires
success and error/denial, giving 966 outcome requirements. Complete HTTP, live
MCP and Agent-chat browser SSE coverage remain outstanding. Genuine Jobs
execution and in-flight native recovery also remain outstanding. The
fixed codec scenarios author all eight required codec behavior groups, with real
CI validation still required for every expectation.

## Current integration limits

No conformance, unit, typecheck, lint, or dependency-install verification result
has been established by this authoring session. The lockfile importer reuses the
baseline's exact existing resolutions; the controller must verify a frozen install.

Route remaining cross-owner work through the terminal controller:

- I/H: expose the existing Claude `sdkEntrypoint` through Main production
  discovery, qualification, metadata and query construction, without removing
  qualification or changing the prototype permission model. The installed worker
  inspection/qualification path already forwards its selected entrypoint.
- J/Q-CI: supply an already-authorized disposable runtime through supported
  `job-queue.json` and `job-runtime.json` configuration, including actual host,
  root, binary, runtime and seed pins. Genuine native qualification/admission
  and durable Job process/output receipts remain required; scripted Agent
  answers, invented proof, new grants or capability widening cannot replace them.
- I: agree and provide Go administrative credential issuance corresponding to
  the TS `credential issue --audience operator --access manage|read-only` behavior.
  The launcher currently expects `foreman credential issue` and reports a real
  setup failure if that command is absent.
- Q-CI: wire the commands/result contract above into the existing CI suite names,
  supply the isolated job prerequisites, and dispatch full TS and Go runs.

Acceptance still requires a merged fork-main SHA and real CI tickets/results.
This package never publishes a release, changes the deployed Foreman application,
or writes Linear.
