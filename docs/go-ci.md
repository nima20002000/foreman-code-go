# Go CI in the migration fork

## Current bounded requests

The current fork resolves affected work from explicit existing files and named
Go test roots. Full scope is reserved for an explicit release. Historical
full-scope dispatch notes below describe earlier migration checkpoints and do
not authorize repeating full suites for an affected change.

An inner committed native-test selection can opt into the race detector with
`"goRace": true`. The same request must select existing Go test files and
nonempty `goTestRoots` for their exact packages. Only `unit` and `integration`
actions accept race execution. The runner adds the fixed `-race` flag to its
existing uncached JSON test command and retains the anchored root filter;
there is no environment or arbitrary-command override. Opted-in command receipts
record the requested race/profile state and actual command exit. Ordinary
command receipts retain their existing shape. Real Go
events, the native report lifecycle, missing-root checks, zero-test checks,
and converter failures retain their existing behavior. Requested race state
alone is not execution or race-detector qualification evidence.

Ordinary Go build, typecheck and lint wrappers declare their prerequisites in
`scripts/ci-native-actions.json`. Each entry maps a selected script test to
an exact inner `suite` and committed `selection` file. The inner suite must be
build, typecheck or lint, and its selection must contain only existing Go
files. The cloud prerequisite decision follows only the wrapper selected for
execution. Reading or checking that wrapper's source, or leaving a manifest
entry unselected, does not request native preparation. These declarations
are separate from `ci-native-selectors.json`: action wrappers keep ordinary
JavaScript assertions and request zero Go test cases or native test reports.
The production action registry starts empty; the terminal's exact-source
probe composition supplies each actual bounded action declaration.

A selected Go request may declare `"nativePrerequisites": ["openssl"]`.
This finite profile selects the committed OpenSSL 3.5.7 helper and source
checksum. It accepts no provider command, path, library version or environment
override through the CI request. The helper installs into the private
`FOREMAN_CODE_CI_OPENSSL_CACHE/toolchains/` cache; the suite captures that cache
before isolating HOME and tracks its installation through the existing
preparation lifecycle. CircleCI and GitHub Actions use the helper's exact
cache identity and retain only the published toolchain directory.

Before a selected provider loads, the profile isolates OpenSSL configuration
and certificate-store paths, clears inherited key-log settings, and verifies
CGO, headers, linked libraries, and runtime library identity. Selected tests
receive the fixed CI-owned OpenSSL execution wrapper; its receipts describe
the actual loaded libraries in each test process. The prerequisite receipt
and test-process receipts are retained under `CI_STATE/go/openssl`, together
with normal Go events and results. CLI version output alone does not prove
the loaded provider. A disabled CGO build cannot qualify the provider.

These additions are source changes awaiting terminal-dispatched explicit
remote/cloud Foreman CI. Select only their new behavior cases and impacted
existing cases. The S/H race and R provider requests require the terminal to
compose their separately pinned product source and exact roots. Existing
known-failing formatter/build/vet/Staticcheck action subjects remain held
until their owners supply corrected source. Unsupported explicit remote
lint/typecheck dispatch also remains held pending the separate deployed-app
decision. No deployed application change or migration acceptance is claimed.

The current source handoff is limited to `nima20002000/foreman-code-go` and
one reviewable source ZIP. Q-CI does not publish source, push, open or update
pull requests, or write Linear. The terminal alone dispatches actual CI and
writes Linear under the current task instructions.

## Historical checkpoint reference

All sections below retain earlier migration checkpoint descriptions and
evidence. Their full-suite commands, mandatory full-scope dispatch advice,
mirror and PR publication instructions, and earlier result counts are
superseded for this affected Q-CI handoff by **Current bounded requests**
above. They provide historical implementation context and no authority to
repeat suites, publish source, change repositories, or claim current-head
verification. Full-scope examples apply only to an explicitly authorized
release; use exact current selections for affected work.

The fork keeps the existing Foreman CI suite and part names. The tested
commit's scripts map backend parts to the complete `backend/` Go module and
retain the web, contracts, and scripts checks. The frozen TypeScript API's
own unit and integration suites do not run in fork CI.

This is CI tooling for `nima20002000/foreman-code-go`. The terminal controller
owns the separate benchmark workspace, approved sanitized mirror
`nima20002000/foreman-code-go-ci`, real CI dispatch, and Linear updates.
Q-CI updates its authorized fork PR. These scripts do not configure the
deployed Foreman app or its CI computers.

## Suite mapping

| Existing name | Work performed |
| --- | --- |
| `typecheck-api` | `go build ./...` and `go vet ./...` in `backend/` |
| `typecheck-other` | Contracts and web typecheck; conformance typecheck when its package exists |
| `lint-api` | Empty `gofmt -l .` output; pinned Staticcheck for ordinary and integration builds |
| `lint-other` | Contracts, web, and conformance lint when its package exists |
| `unit-api` | Uncached `go test -json -count=1 ./...`, without a database URL |
| `unit-web` | Retained fast web tests with existing duration shards |
| `unit-web-heavy` | Retained heavy web tests and the existing graph smoke phase |
| `unit-other` | Contracts, scripts, and conformance package unit tests when its package exists; scripts receive a fresh disposable test server |
| `build-api` | `go build ./...` in `backend/` |
| `build-other` | Contracts and web build |
| `integration` | Go integration tests against a fresh PostgreSQL server, an actual Go executable build, and full Go conformance; also TS conformance when `conformance/` differs from fork `main` |
| Root `typecheck`, `lint`, `unit`, `build` | Corresponding Go and retained TypeScript work |

Root package scripts use `ci-root-suite.mjs` inside CI because the deployed
host runner calls root package scripts for unpartitioned suites, including
integration. Outside CI those entry points preserve their ordinary commands.
The root `package.json` script edits must be integrated with I's manifest work.

Go always checks `./...`. Old TypeScript file indexes and partitions do not
select Go packages or Go tests. The affected selector requests full scope;
the affected command entry point also routes nonempty old selections to full
fork CI. Before that delegation, `--files-from` is read and validated: malformed
JSON, non-array payloads, missing or nonregular files, absolute paths,
traversal, and non-normalized repository paths are rejected. A valid empty
selection also delegates the full suite; Go's nonzero-test check remains
mandatory. Retained web duration shards remain available through their
existing parts.

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
and, for integration, the disposable Go integration database and cached
conformance PostgreSQL executables asynchronously. `unit` and `unit-other`
also prepare their separate retained-script database. `prepare` performs the
same preparation synchronously for the host runner. The suite waits for the
applicable prerequisite and forwards actual preparation log output while
waiting; it does not invent test activity.

The Go installer reads exact versions, release dates, and Linux archive
SHA-256 values from `scripts/ci-go-versions.json`. Go is installed below
`FOREMAN_CODE_CI_GO_CACHE/toolchains/`; module, build, tool, and GOPATH state
remain under the same prefix. The default cache is under the original CI
user's cache directory. It does not install Go system-wide on a build computer.
The installer rejects pins recorded as less than 48 hours old, verifies the
downloaded archive, checks the resulting Go version, and serializes writes to
a shared cache. Ordinary CI commands use `GOTOOLCHAIN=local`.

If the archive download fails, the installer can use an existing trusted stable
Go 1.21 or newer from the build-image PATH. Discovery accepts plain and versioned
executables such as `/usr/bin/go1.26.8`, excluding repository, runtime, HOME,
and CI-cache locations. A fresh invocation owns its HOME, module cache, build
cache, and GOPATH. The fallback disables inherited Go workspace/configuration
overrides and asks that bootstrap for exactly `GOTOOLCHAIN=go1.27.2`.

When switching versions, the standard Go mechanism downloads the toolchain
module through `GOPROXY=https://proxy.golang.org` with
`GOSUMDB=sum.golang.org`. An empty invocation PATH prevents a versioned shim
from substituting for that download. The returned GOROOT must be the exact
toolchain module inside the invocation's own cache, and the resulting compiler
must report the pinned version before publication. Go documents this behavior
under [downloading toolchains](https://go.dev/doc/toolchain#downloading-toolchains).
An already exact trusted bootstrap can reuse its verified bundled installation;
the installer identifies that source explicitly rather than calling it a module
download. The staged cache copy is version-checked too.

Archive checksum or extraction failure stays terminal and never enters the
fallback. A module's `h1` checksum is not the archive SHA-256 and is never
substituted for it. Before removing the invocation directory, cleanup invokes
the trusted bootstrap with `GOTOOLCHAIN=local go clean -modcache` against only
that fresh module cache. A cleanup failure remains red and preserves the
invocation directory; shared CI module caches are never cleaned by this path.

The current pins are Go 1.27.2 (released October 8, 2026) and Staticcheck
v0.8.2 (released October 12, 2026). Staticcheck's release supports Go 1.27.2's
export format. Their release records and Go archive checksums are linked
from the version file. Retained TypeScript uses `corepack pnpm` and the
repository's existing `packageManager` pin, `pnpm@11.27.0`.
I owns `backend/go.mod`, `backend/go.sum`, and generated contracts; no backend
module or contract shapes are invented by these CI scripts.

The reviewed skeleton in [fork PR #1](https://github.com/nima20002000/foreman-code-go/pull/1),
at head `c5ed881021bec93bbb2f3e750dbfa1259c83d05d`, declares the backend module
and `toolchain go1.27.2`. The controller's later integration candidate
`fc326c28fbea28d9964bdd25abef0c286faad65f` contains the genuine `backend/go.sum`.
The CI patch remains based on the exact task baseline and must be composed
with those foundation inputs by the controller. Module resolution uses
`-mod=readonly`; CI will not silently generate checksums or repair the tested
commit. The operator has separately captured the genuine `baseline.sql` and
proof for the restored 183 migrations; the controller intakes those foundation
artifacts and formatting fixes. They are not regenerated or replaced by this
CI patch.

Approved Linux build images need C and C++ compilers, GNU make, Perl, `pkg-config`,
libvips development files, Docker, and the installer utilities `curl`, `tar`,
coreutils, `flock`, and `setsid`. The conformance launcher also needs `git`,
OpenSSL, `ss`, and Linux `/proc`. Cloud jobs install their native development
packages within the job. Build computers receive an actionable missing-
prerequisite error instead of a system package installation or settings change.

Use a fresh absolute `CI_STATE` for each dispatch. It remains the provider's
artifact and lifecycle anchor. The suite records a short, private runtime
directory under `/tmp/fci.*` and puts HOME, XDG, harness configuration, and
temporary files there. This keeps extensionless CommonJS test programs outside
the repository's `type: module` package scope and keeps Unix socket paths short.
Reusing or deleting that runtime requires matching ownership, private modes,
and its binding to the same CI state. The suite captures the existing Corepack
cache before switching HOME. Database aliases and API environment-file
overrides inherited from the host are cleared before tests run.

Integration creates a UUID-named PostgreSQL container with generated
credentials and a random loopback port. It uses no existing installation,
database, host data directory, or named persistent volume. Cleanup checks the
recorded ownership label and removes only that run's container and anonymous
volume. The existing controller CPU and memory assignments are honored.
Host `db:down` and cancellation calls are routed to that same exact cleanup.
Inspection and removal run under one per-profile lock. A canceled starter
retains its ownership record until a delayed Docker creation has been
reconciled, so concurrent cleanup paths remove the container once.

Retained scripts use a separate fresh server with the existing disposable
administrator identity and `graphql_test_control` database. The existing
`test-postgres-init.sql` establishes its required ownership markers before
the environment is published. Its random loopback `/postgres` URL and valid
run UUID satisfy the unchanged `test-resources.mjs` guards. This preparation
precedes the native-acceptance command's own path validation; no fallback to
the fixed port 55439 or shared CI database is introduced.

`bash scripts/ci-suite.sh cleanup` reconciles tracked preparation and owned
databases, then removes the recorded runtime while retaining reports. Provider
teardown and the host database cleanup entry point use this action when a job
ends before its normal suite cleanup. Cleanup does not install tools or execute
tests.

The PostgreSQL image is `postgres:17.6-alpine`, a version tag rather than a
verified immutable digest. No image pull or real PostgreSQL startup has been
verified in the authoring environment.

The generated disposable connection is scoped to Go integration tests as
`DATABASE_URL`, `TEST_DATABASE_URL`, and `FOREMAN_CODE_CI_TEST_ADMIN_URL`.
Those aliases and PostgreSQL client environment variables are cleared before
conformance launches. Q-CONF creates a different database cluster, random
port, application HOME/state, and isolated worker pairing for each scenario.

### PostgreSQL executables for conformance

Q-CONF's unprivileged launcher calls real `initdb`, `postgres`, `pg_isready`,
`psql`, and `createdb`; a connection to the Go integration container cannot
satisfy that interface. `ci-postgres-toolchain.sh` installs PostgreSQL 17.6
from its pinned, checksum-verified release source under
`FOREMAN_CODE_CI_POSTGRES_CACHE`. The default is the original CI user's
`~/.cache/foreman-postgres`, captured before HOME isolation. Cloud providers
use their declared CI cache path. No data directory or running database is
part of this cache.

The helper also builds pinned M4, Bison, and Flex in that cache because the
PostgreSQL 17 release source requires parser generators. Versions, release
dates, archive hashes, and primary-source links are recorded in
`scripts/ci-postgres-versions.json`. Every pin must be at least 48 hours old.
Flex's archive is checked against both the upstream SHA-1 and the SHA-256
published for the identical original archive in Debian's signed source
upload metadata. C/C++ compilers, make, and Perl remain existing-image
prerequisites. Optional ICU, readline, and zlib support is disabled for this
isolated test server.

An exclusive installation lock prevents partially built executables from
being published. The cache identity includes the pinned manifest, installer
and wrapper source, CPU architecture, compiler version, and glibc version.
The exported absolute `CONFORMANCE_POSTGRES_BIN_DIR` contains wrappers that
execute the actual cached binaries and supply their own library path.
This matters because Q-CONF intentionally drops inherited `LD_LIBRARY_PATH`.
Parser-generator data paths are resolved from the restored installation too.

The installer never initializes a database or starts a server. It refuses
UID 0 and does not switch users. Q-CONF owns each fresh cluster and its
cleanup; the build computer and shared CI database are not reconfigured.
Both the cold source build and restored-cache execution require real CI
verification.

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

### Q-CONF launcher and raw report

The interface follows [Q-CONF PR #3 at `21f72452c2c4d5350514f75b3aaddfe33efa72ed`](https://github.com/nima20002000/foreman-code-go/tree/21f72452c2c4d5350514f75b3aaddfe33efa72ed/conformance).
The controller composes that owner's launcher and expectations with this CI
patch and I's backend. Q-CI does not supply scenarios or redefine domain
contracts.

Integration explicitly runs `go build -o "$CI_STATE/bin/foreman" ./cmd/foreman`
from `backend/` before Go conformance. It removes any previous output first
and passes that executable as `CONFORMANCE_GO_BINARY`. A package-only
`go build ./...` is insufficient for this handoff. A failed executable build
keeps integration red even if another check succeeds.

For each required target, the suite captures the unfiltered inventory with
`pnpm --silent --dir conformance run conformance --list`, then invokes
`pnpm --silent --dir conformance run conformance`. It passes
`CONFORMANCE_TARGET=go|ts`, `CONFORMANCE_RESULTS_FILE`, the built Go binary,
and the cached PostgreSQL binary directory. `--silent` removes pnpm's own
banner; the launcher's real scenario and summary NDJSON is retained and
forwarded unchanged. `CI_PROGRESS_FILE` remains available to the launcher.
Launcher and output-copy exit codes are captured independently.

The launcher owns the complete JSON report. Conversion validates its actual
`schemaVersion: 1` interface:

| Evidence | Validation and retention |
| --- | --- |
| Provenance | Exact fork repository, original source baseline, target, tested commit SHA, and `commitSource` (`git` or `environment`) |
| Selection | Full inventory IDs, titles, and owning lanes match the report; duplicate IDs and missing terminal outcomes fail |
| Outcomes | Unique `id`, title, lane, terminal `status`, `phase`, `executed`, measured `durationMs`, and complete failure trees |
| Totals | Overall counts and all eight lane totals agree with the actual terminal outcomes; `executed` agrees with execution flags |
| Scope | `scope.kind`, requested lanes/IDs, and `completeSelection` agree; smoke and filtered selection cannot satisfy CI |
| Coverage | HTTP, behavior, and live MCP coverage status, counts, missing/unexpected requirements, and `complete` agree |
| Run status | Reported pass/fail, setup/cleanup errors, and measured run timing remain intact |

The expected commit is the actual checkout's `git rev-parse HEAD` unless
the controller explicitly supplies `CONFORMANCE_COMMIT_SHA`. The latter
records `commitSource: environment` for a sanitized capture and must identify
the actual corresponding fork commit; the scripts cannot infer a fork SHA
from a mirror capture SHA. A report with different provenance fails. The
original `CONFORMANCE_BASELINE_SHA` remains the exact task baseline and is
distinct from the later main report used for non-regression.

Setup failures have `phase: setup` and `executed: false`. They remain failed
outcomes in the raw report, selected totals, and lane diagnostics. Because
the existing bounded CI schema has no execution flag, the converter emits
failed setup groups without fabricated test assertions. Only executed
scenario outcomes become per-test rows. Executed cleanup failures remain
failed rows. Go and TS rows are grouped separately under
`conformance/<target>/<lane>`; measured durations and complete totals are
reported without replacing the raw artifact with a bounded view.

Each target retains these artifacts under `$CI_STATE/conformance/`, outside
the disposable HOME:

| Artifact suffix | Contents |
| --- | --- |
| `<target>.json` | Complete, unchanged launcher report, including every failure and coverage gap |
| `<target>.inventory.json` | Actual full inventory captured from this checkout's launcher |
| `<target>.jsonl`, `<target>.stderr.log` | Complete retained launcher output and diagnostics |
| `<target>.vitest.json`, `<target>.durations.json` | CI adapter rows and measured duration map |
| `<target>.full-verdict.json` | Truthful full-conformance verdict with totals, executed count, and coverage |
| `<target>.gate.json` | Separate CI policy verdict, required SKEL outcomes, and exact-main comparison status |

Cloud jobs retain the conformance artifact directory even when the job fails.
On build computers the directory survives suite HOME cleanup and full
scenario/summary output remains in the CI log. The controller must retain
these files before disposing of a run's `CI_STATE`.

### Incremental CI and complete acceptance

`CONFORMANCE_GATE=incremental` is the early migration default. The
[migration plan](https://linear.app/nima1999/document/foreman-code-go-backend-migration-plan-3114a8d21da6)
requires a green full CI round with nonzero Go tests and no regression of
scenarios already passing on fork main. [NIM-2898](https://linear.app/nima1999/issue/NIM-2898)
also requires real Go `SKEL` health/readiness/error conformance. A 100% Go
conformance result belongs to P1-ACCEPT; it is not silently imposed on the
first skeleton merge.

The incremental conformance gate therefore requires a valid complete
inventory/report, normal and consistent launcher termination, nonzero
executed scenarios, and no run-level setup or cleanup failure. Every selected
Go `SKEL` scenario must execute and pass, with at least one SKEL scenario
selected. Go build, vet, lint, unit, and integration-test failures remain red;
the gate never overrides those commands or turns a zero-Go-test result green.

Later-lane failures, per-scenario setup failures, and coverage gaps remain
visible in the unchanged raw report and its failed full-conformance verdict.
The CI gate may separately pass the early requirements. The retained CI
test table still shows executed failures; a green process verdict does not
mean that full conformance passed. TS-target runs use the same complete
selection, execution, and regression checks. Their full oracle qualification
remains a separate Q-CONF acceptance result and must pass before lanes rely
on those expectations.

When real exact-main artifacts are available, the controller supplies:

- `CONFORMANCE_MAIN_GO_RESULTS_FILE` for the Go main report;
- `CONFORMANCE_MAIN_TS_RESULTS_FILE` for the TS main report when available;
- `CONFORMANCE_MAIN_COMMIT_SHA` for the exact corresponding fork-main SHA.

A supplied target report and its SHA must agree. The gate validates that
historical report and compares every ID that actually executed and passed
there. A missing, unexecuted, or failed current outcome for any such ID is a
regression. Current newly added scenarios are not invented on historical main.
An absent target baseline is recorded as `nonRegression.status: not-available`,
with no fabricated baseline count or passing verdict. A real main report with
zero passing IDs records the actual zero comparison and `not-established`;
it does not claim regression proof. This also covers an actual main report
whose outcomes all failed during setup: its zero executed count remains zero,
while the current candidate must still execute and pass SKEL. The report makes
the lack of comparable passes explicit without adding a requirement that
unimplemented main scenarios first pass. The controller assesses the early
merge requirements using the actual full CI, SKEL, and available main evidence.
Supplying an unreadable, mismatched, or filtered main report fails; it does
not silently fall back to no baseline.

`CONFORMANCE_GATE=complete` additionally requires the full-conformance
verdict to pass: every selected scenario passes, all coverage is complete,
and no setup/cleanup or runner failure exists. This is the conformance mode
for P1-ACCEPT and P2-RETIRE; their full clean round and isolated real-harness
smoke remain separate required evidence.

Missing launcher/report, malformed evidence, duplicate or missing inventory
IDs, incomplete outcomes, contradictory totals, filtered selection, zero
execution, launcher crashes, and artifact-copy/conversion errors fail in
both modes. A valid but failed full report returns converter exit 1; invalid
evidence returns exit 2. Only the separate gate can accept an incremental
result, and it never rewrites the raw report. Go conformance is attempted on
every integration dispatch. When a diff against fork main cannot be obtained,
the suite conservatively requires the TS target too.

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
4. Full-selection Go conformance with the raw report, actual executed counts,
   failures, coverage gaps, and all lane totals; an actual conformance change
   also exercises the TS target. Record the incremental and full-conformance
   verdicts separately and compare actual passing exact-main scenario IDs.
5. A passing full round for the merged fork-main SHA, with real CI ticket IDs
   and conformance counts. Recheck the merged code rather than attributing a
   branch's results to a different commit.

Keep tests and smoke runs in fresh databases, random ports, isolated HOME and
state, and isolated worker pairings. Preserve the prototype permission model.
Only the controller publishes the approved mirror or writes Linear. Q-CI
handles follow-up tooling fixes without changing other owners' scenarios or
the deployed Foreman app.

### Historical verification evidence and limits

The controller reported real CI for fork candidate
`fc326c28fbea28d9964bdd25abef0c286faad65f`: Go unit results of **200 passed,
0 failed, 0 skipped on five cloud replicas**. Those are repeated unit-run
results, not conformance counts or proof for this updated PR head.
Retained unit-other ticket `3f564398-3e36-4768-9ee0-46efb2e0d30a` recorded
**2329 passed, 16 failed, 0 skipped**. The overall round was red.
[Controller fixture PR #4](https://github.com/nima20002000/foreman-code-go/pull/4),
head `b7eb31d65cfb805855b80c3b47ca1b03b24bd608`, owns the three affected-run,
selection, and acceptance-safety test fixture updates. Its assertions remain
required; the corresponding production plumbing belongs to Q-CI.

An earlier controller-reported Main capture,
`807bcf90ecbe19e8da744d7a701b8a30c5a60006`, failed downloading Go with HTTP 404
before compilation (ticket `8fe3efaa-98d4-4d56-a46d-b5cad8cfd849`). The
controller verified that official metadata matches Go 1.27.2 and the
committed checksums. This patch keeps those pins unchanged. The later Go
unit results establish that those particular runs reached execution; they
do not establish a complete conformance baseline.

The controller then verified the official toolchain-module installation on
affected worker `bb252`, ticket `6d2b1ef1-1c17-4dde-b4de-3401fc95adb0`, source
`92a282c1fd2faa994e9d88b9d54cff2ad5224670`. Its installed `/usr/bin/go1.26.8`
downloaded and ran exact Go 1.27.2 with `GOTOOLCHAIN=go1.27.2`,
`GOPROXY=https://proxy.golang.org`, and `GOSUMDB=sum.golang.org` in a fresh
owned cache. This establishes the operator's fallback mechanism; it does
not validate the revised installer or the rest of this PR.

The interface, executable, PostgreSQL, gate, and plumbing regressions are
authored for the retained CI script unit suite and have not been executed
locally. Q-CI's connected tools do not currently expose Foreman CI MCP
dispatch or ticket inspection; the results above are controller-provided
evidence. Real updated-head build-computer/CircleCI rounds, remaining
pre-fix red proof, throwaway failing/zero-Go-test cases, and merged-main
results remain controller-dispatched work. No ticket, scenario count,
schema dump, or passing baseline is synthesized here.

## Task sources

- [Q-CI issue NIM-2899](https://linear.app/nima1999/issue/NIM-2899)
- [Migration master NIM-2897](https://linear.app/nima1999/issue/NIM-2897)
- [Backend migration plan](https://linear.app/nima1999/document/foreman-code-go-backend-migration-plan-3114a8d21da6)
- [Exact source baseline](https://github.com/nima20002000/foreman-code-go/tree/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f)
