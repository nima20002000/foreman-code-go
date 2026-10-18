# Native provider-account status reads

This package advances the remaining native read portion of H / NIM-2906 Step 1.
`ReadStatus` observes Codex or Claude authentication status through injected,
finite command and qualified-selection ports. It does not start a login, change
credentials, register a route, or construct a shared account observation DTO.

The source base is fork PR64 commit
`86489bf2d13247a8b1580ddea5e9b14ecf34d84e`, tree
`4d8581dad16e6fa62ba99bab8ce089119e6d5a25`. This slice adds only the seven files in
`backend/internal/provideraccounts`; every existing base path stays unchanged.
The catalog package and its 18 authored roots and cancellation witness are
retained as source, with their terminal qualification still pending.

## Frozen reference

The TypeScript reference remains
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`, without a baseline refresh:

- [nativeCommands.ts](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/provider-accounts/nativeCommands.ts),
  specifically `inspectStatus`, its selected/dispatch boundary and identity checks.
- [nativeCommands.test.ts](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/provider-accounts/nativeCommands.test.ts).
- [productionSelection.ts](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/provider-accounts/productionSelection.ts)
  and [ports.ts](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/provider-accounts/ports.ts)
  define the owning installation and native command boundaries.

## Native behavior

The reader selects an already qualified immutable installation, reserves command
ownership, rechecks that complete selection, checks status support, runs the
finite command, closes ownership, handles any command error, rechecks selection
after cleanup, and only then decodes the result. The commands are Codex
`login status` and Claude `auth status --json`, each with a 15-second requested
timeout. No inference, account mutation or SDK process is invoked here.

Cleanup runs after a failed prelaunch check, unsupported status or command
failure whenever preparation transferred ownership. A cleanup error replaces
the inspection error directly. The existing `domainerror` classification turns
domain failures into an unavailable observation; ordinary errors retain their
identity and wrapping. A final stale selection suppresses publication. Context
is forwarded to the native ports, while `Close` has an independent cleanup
lifetime. This frozen status boundary has no additional post-cleanup cancellation
rule; a selection adapter may return the caller's cancellation error itself.

Codex requires exit code zero plus the case-insensitive ChatGPT sign-in substring
for signed-in. A complete, whitespace-surrounded `not logged in` result is
signed-out for any present exit code. Missing exit status, timeout, API-key text
and all unrecognized output are unavailable. Matching uses the frozen JavaScript
ASCII pattern and whitespace semantics, including FEFF and excluding NEL; Unicode
case folding must not add long-s or dotted-I matches.

Claude requires exit code zero and a JSON object. Literal `loggedIn: false`
short-circuits to signed-out. Literal `true` is signed-in unless native
`String(authMethod)` equals `api_key` or `api-key`. The small marker predicate
retains array conversion and an object's own non-callable `toString` failure,
including a later failure after an earlier array mismatch. Such failures produce
a fresh ordinary `AuthMethodConversionError` with the native TypeError message;
they are distinct from malformed JSON, which is unavailable. This observation is
Claude's native subscription status. Saved API-key credential availability remains
the provider-account service's responsibility.

An identity is returned only for a native email string with at most 200 UTF-16
units, no C0 or DEL control, and the frozen permissive email pattern. It is not
trimmed or tightened to a different email validator. `jsonvalue.UTF16String`
preserves lone surrogate units and avoids lossy UTF-8 conversion. Other native
fields, diagnostics and tokens are not returned.

## Real adapters still required

`Selection` is a narrow view, not a replacement schema. Its adapter must qualify
the actual executable, profile, isolation, account binding, generation,
qualification and support flags before returning it. Both `IsCurrent` calls must
reselect, revalidate and compare the **complete** native snapshot. The finite
test fixture proves the reader's call ordering; it does not prove these production
qualification or equality rules.

`Prepare` reserves the command and must not dispatch it before the prelaunch
check. Failed preparation cleans its own partially acquired resources. Successful
preparation transfers a command whose `Close` confirms physical process exit and
owner cleanup, including when `Run` never ran. The real process adapter also owns
environment and profile isolation, stdout/stderr byte decoding and normalization,
the frozen 32,768 UTF-16 capture bound, timeout enforcement and shutdown tracking.
No raw transport close is claimed to establish physical process exit.

`DecodeSubject` receives only the actual qualified native subject field and
qualification ID after native string and C0/DEL checks. It must apply the real
generated subject schema, its clock and qualified-native provenance rules. The
generic `SubjectValue` carries that adapter's actual validated type; this package
does not copy a subject DTO, trim/validate a substitute Reference schema, or
serialize a domain observation. `QualificationID` is adapter-owned Go text, and
its validity and domain encoding remain the adapter's responsibility. Missing a
decoder for a present qualified candidate is an ordinary wiring error, not a
silent claim that subject validation succeeded. The test decoder is an opaque
accept/reject fake and provides no generated-schema qualification.

Shared generated DTO/schema002 remains blocked by the I-owned memoizer export
defect. Production subject, selection, launcher/guardian and account service
adapters are not wired by this slice. Login-pending, observation sequencing,
binding/generation receipts, stored API keys, database writes and public HTTP/MCP
translations remain with their existing owners. There are no generated outputs,
route registrations or startup edits here. H Step 1 and the full lane remain
open, and this slice does not advance Step 2. The permanent provider decisions
remain official Claude SDK 0.3.284 through its thin Node bridge, and Codex 0.154.0
through native Go JSON-RPC.

## Public checks and terminal qualification

All tests call exported `ReadStatus` from `provideraccounts_test`, using finite
in-memory native results and explicit ownership/selection ports. They cover native
classification, malformed data, UTF-16 identities, qualified subject delegation,
stale selections, cleanup/error precedence, command arguments and context
forwarding. They use no real CLI, application, computer, port, HOME or database.

These are new-feature assertions: this package and public API do not exist at
the base commit. No compiler/setup failure is an authentic old behavior red.
The retained interim source and any subsequently confirmed test-only witnesses
are identified in the delivery provenance. Authored and statically reviewed does
not mean runtime passed: every new test, build, vet, formatter and lint request
remains unrun until the terminal Foreman CI MCP returns actual receipts.

The exact candidate and affected arguments are in `ci-handoff.json` in the
delivery. The affected scope is the 15 authored `TestReadStatus...` roots in this
package, once with `-race -json -count=1 -timeout=30s`, this package's `go build`,
`go vet` and Staticcheck, and only these six new Go files for `gofmt -l`:
`ports.go`, `status.go`, `decode.go`, `text.go`, `status_test.go`, `decode_test.go`.
Terminal must use genuine Go 1.27.2 and Staticcheck v0.8.2 from the retained
`scripts/ci-go-versions.json` pins. No suppressions, disabled checks or formatter
approximations are used.

Future CI needs a fresh exact candidate checkout, private HOME/state/temp/module
and build caches, no real database or worker pairing, and actual cleanup receipts.
No network ports or subprocesses are required by these finite fixtures. If the
terminal harness needs infrastructure, it must allocate isolated resources and
random ports. No unchanged catalog, Codex, Claude, discovery, queue, producer or
merged diagnostic suites are selected. Historical cleanupfalse remains a failed
cleanup receipt even though a later independent cleanup passed.
