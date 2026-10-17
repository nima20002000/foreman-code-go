# Go CI in the migration fork

The fork keeps the existing Foreman CI suite and part names. The tested
commit's scripts map backend parts to the complete `backend/` Go module and
retain the web, contracts, and scripts checks. The frozen TypeScript API's
own unit and integration suites do not run in fork CI.

This is CI tooling for `nima20002000/foreman-code-go`. The terminal controller
owns the separate benchmark workspace, approved sanitized mirror
`nima20002000/foreman-code-go-ci`, real CI dispatch, remote Git operations,
and Linear updates. These scripts do not configure the deployed Foreman app.

## Suite mapping

| Existing name | Work performed |
| --- | --- |
| `typecheck-api` | `go build ./...` and `go vet ./...` in `backend/` |
| `typecheck-other` | Contracts and web typecheck; conformance typecheck when its package exists |
| `lint-api` | Empty `gofmt -l .` output; pinned Staticcheck for ordinary and integration builds |
| `lint-other` | Contracts and web lint |
| `unit-api` | Uncached `go test -json -count=1 ./...`, without a database URL |
| `unit-web` | Retained fast web tests with existing duration shards |
| `unit-web-heavy` | Retained heavy web tests and the existing graph smoke phase |
| `unit-other` | Contracts and scripts unit tests |
| `build-api` | `go build ./...` in `backend/` |
| `build-other` | Contracts and web build |
| `integration` | Go integration tests against a fresh PostgreSQL server, then Go conformance; also TS conformance when `conformance/` differs from fork `main` |
| Root `typecheck`, `lint`, `unit`, `build` | Corresponding Go and retained TypeScript work |

Root package scripts use `ci-root-suite.mjs` inside CI because the deployed
host runner calls root package scripts for unpartitioned suites, including
integration. Outside CI those entry points preserve their ordinary commands.
The root `package.json` script edits must be integrated with I's manifest work.

Go always checks `./...`. Old TypeScript file indexes and partitions do not
select Go packages or Go tests. The affected selector requests full scope;
the affected command entry point also routes nonempty old selections to full
fork CI. Retained web duration shards remain available through their existing
parts.

### Dispatch limitation in the existing host runner

The controller must dispatch migration proof rounds with **`scope: full` and
without `files`, an integration partition, or an integration gate**. In the
baseline deployed runner, an explicitly empty affected selection can become
the command `true` before any repository suite hook runs. Integration gates
and partitions also enumerate the frozen API's TypeScript test files. An
uncalled fork script cannot change that behavior. Such tickets provide no Go
proof and must not be accepted as migration evidence.

This limitation is established by the baseline runner's `selectFiles` and
`script` methods and its file-presence capability detection; it does not
authorize changing the deployed application or contracts.

## Preparation and isolation

`SUITE=<part> bash scripts/ci-suite.sh start` prepares the required Go cache
and, for integration, PostgreSQL asynchronously. `prepare` performs the same
preparation synchronously for the host runner. The suite waits for preparation
before executing checks.

The Go installer reads exact versions, release dates, and Linux archive
SHA-256 values from `scripts/ci-go-versions.json`. Go is installed below
`FOREMAN_CODE_CI_GO_CACHE/toolchains/`; module, build, tool, and GOPATH state
remain under the same prefix. The default cache is under the original CI
user's cache directory. It does not install Go system-wide on a build computer.
The installer rejects pins recorded as less than 48 hours old, verifies the
downloaded archive, checks the resulting Go version, and serializes writes to
a shared cache. Automatic Go toolchain switching is disabled.

The current pins are Go 1.27.2 (released October 8, 2026) and Staticcheck
v0.8.2 (released October 12, 2026). Staticcheck's release supports Go 1.27.2's
export format. Their release records and Go archive checksums are linked
from the version file. Retained TypeScript uses `corepack pnpm` and the
repository's existing `packageManager` pin, `pnpm@11.27.0`.
I owns `backend/go.mod`, `backend/go.sum`, and generated contracts; no backend
module or contract shapes are invented by these CI scripts.

The reviewed skeleton in [fork PR #1](https://github.com/nima20002000/foreman-code-go/pull/1),
at head `c5ed881021bec93bbb2f3e750dbfa1259c83d05d`, declares the backend module
and `toolchain go1.27.2`. It does not contain `backend/go.sum` or the actual
baseline schema dump. Those are unresolved foundation inputs. The CI patch
is still based on the exact task baseline and must be composed with I's work
by the controller. Module resolution uses `-mod=readonly`; CI will not silently
generate missing checksums or repair the tested commit.

Approved Linux build images need a C compiler, `pkg-config`, libvips
development files, Docker, and the installer utilities `curl`, `tar`,
`sha256sum`, `flock`, and `setsid`. Cloud workflows install the native
development packages. Build computers receive an actionable missing-
prerequisite error instead of a system package installation.

Use a fresh absolute `CI_STATE` for each dispatch. The suite puts its empty
HOME and XDG directories under that state. It captures the existing Corepack
cache before switching HOME. Database aliases and API environment-file
overrides inherited from the host are cleared before tests run.

Integration creates a UUID-named PostgreSQL container with generated
credentials and a random loopback port. It uses no existing installation,
database, host data directory, or named persistent volume. Cleanup checks the
recorded ownership label and removes only that run's container and anonymous
volume. The existing controller CPU and memory assignments are honored.
Host `db:down` and cancellation calls are routed to that same exact cleanup.

The PostgreSQL image is `postgres:17.6-alpine`, a version tag rather than a
verified immutable digest. No image pull or real PostgreSQL startup has been
verified in the authoring environment.

The generated disposable connection is exported as `DATABASE_URL`,
`TEST_DATABASE_URL`, and `FOREMAN_CODE_CI_TEST_ADMIN_URL`. PR #1's configuration
reads `DATABASE_URL`; Q-CONF must confirm its launcher inputs through the
controller. Conformance remains
responsible for isolated application state and worker pairing for each target.

## Structured results

`ci-go-test-results.mjs` consumes the real `go test -json` stream. It keeps
interleaved package and named test/subtest results, measured durations, build
failures, and failure locations. Package groups are named `backend` or
`backend/<package>` because Go JSON does not identify each test's source file.
Package failures do not create fabricated named test cases.

The converter writes the intermediate report accepted by
`ci-test-results.mjs`; that existing merger publishes bounded
`CiTestResultsSchema` output. The summary counts all recorded tests even when
the visible table is truncated. Full lane totals also appear in the CI log.
Go and conformance duration files are merged by `ci-unit-files.mjs` within the
existing duration contract's bounds.

Empty Go selections, entirely skipped Go suites, malformed or incomplete
streams, package/build failures, and failing tests return nonzero. Go's own
exit status is retained through the shell pipeline. A report conversion error
cannot turn a failing process green. Valid reports from other executed phases
are still published when available.

The host runner's existing integration output variables are supported:
`FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT` and
`FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT`. Cloud jobs use
`TEST_RESULTS_OUTPUT` and `DURATIONS_OUTPUT`.

### Proposed conformance launcher interface

**This interface is implemented by Q-CI but is not yet agreed with Q-CONF.**
The baseline contains no conformance launcher. The controller must reconcile
this proposal with Q-CONF's actual launcher before integration acceptance.
No scenarios, expectations, or domain contract types are supplied here.

The suite invokes the conformance package's `test:ci` script with
`CONFORMANCE_TARGET=go|ts` and `CONFORMANCE_RESULTS_OUTPUT=<private report>`.
The launcher should also publish live progress through the inherited
`CI_PROGRESS_FILE` convention so a long scenario does not appear idle to the
existing watchdog; final report conversion cannot supply progress retroactively.
The proposed report is Vitest-compatible JSON with this additional metadata:

| Field | Required value |
| --- | --- |
| `conformance.target` | The actual requested `go` or `ts` target |
| `conformance.selected` | The exact integer count of selected scenario assertions |
| `conformance.complete` | `true`, set only after all selected scenarios have terminal results |

The selected count must equal the actual scenario assertions. Each scenario needs its measured
duration and a unique `fullName` beginning with an owning tag: `[SKEL]`, `[E]`,
`[H]`, `[J]`, `[A1]`, `[S]`, `[R]`, or `[A2]`. Go and TS are grouped separately
as `conformance/<target>/<lane>`.

Missing launcher/report, target mismatch, incomplete reports, inconsistent
counts, zero selected scenarios, entirely skipped scenarios, and runner-level
failures keep integration red. Go conformance is always attempted after Go
integration. When the comparison with fork `main` cannot be established, the
suite conservatively requires the TS target too.

## Required controller proof

All further tests must run through controller-dispatched Foreman CI MCP.
Earlier local converter fixtures and static checks are not acceptance evidence.
After I's actual Go module/tests and Q-CONF's launcher are integrated, the
controller must record these real rounds against the reviewed fork commit:

1. Full typecheck, lint, unit, build, and integration on an approved build computer
   and CircleCI, with nonzero Go test results in the test parts.
2. A throwaway failing-Go-test branch that returns red through both execution
   paths. Never merge it.
3. A separate throwaway branch with the selected Go tests removed that returns
   red for zero selected tests through both paths. Never merge it.
4. Go conformance with per-scenario results and complete lane totals; an actual
   conformance change also exercises the TS target.
5. A passing full round for the merged fork-main SHA, with real CI ticket IDs
   and conformance counts. Recheck the merged code rather than attributing a
   branch's results to a different commit.

Keep tests and smoke runs in fresh databases, random ports, isolated HOME and
state, and isolated worker pairings. Preserve the prototype permission model.
Only the controller publishes the approved mirror or writes Linear. Q-CI
handles follow-up tooling fixes without changing other owners' scenarios or
the deployed Foreman app.

## Task sources

- [Q-CI issue NIM-2899](https://linear.app/nima1999/issue/NIM-2899)
- [Migration master NIM-2897](https://linear.app/nima1999/issue/NIM-2897)
- [Backend migration plan](https://linear.app/nima1999/document/foreman-code-go-backend-migration-plan-3114a8d21da6)
- [Exact source baseline](https://github.com/nima20002000/foreman-code-go/tree/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f)
