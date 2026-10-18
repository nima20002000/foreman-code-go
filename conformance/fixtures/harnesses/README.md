# Native fixtures

`setupFixtures` installs all test material in the launcher's new temporary directory.
The launcher must keep that directory for a restart of the same scenario and remove
it after the server and clients have closed. No installed provider package or
existing account home is edited.

## Codex

The selected `codex` executable runs a copy of the existing
`apps/api/test/fixtures/codex-app-server.cjs`, with the checked-in protocol schema
fixture next to it. Model discovery uses the shared Codex default model, and MCP
configuration points at this run's random API port. Default native text,
resume/fork, pending input and interruption behavior comes from that fixture.

Setup builds `codex-forwarder.c` with the real `cc` executable in a fresh owned
build directory. The resulting native executable binds the current Node runtime
and the isolated fixture script as absolute UTF-8 paths, then uses `execv` to
forward arguments, standard streams, signals and the fixture's exit status.
Compiler shutdown and owned-process closure are checked before build files are
removed or the completed executable is selected through the existing PATH and
`CODEX_BINARY` settings. No installed provider is copied or changed. A missing or
failing compiler is a setup failure. These CLI checks do not establish native
qualification; the TS target must still pass its unchanged public admission and
qualification behavior through Foreman CI.

An opt-in adjacent `scripted-turns.cjs` extension handles the native qualification
Markdown task. It reads the exact revision through `files_read`, writes only the
named result in a writable native workspace within the fresh fixture directory,
and publishes through `files_publish_result`. Read-only profiles cannot write.
Without the adjacent extension, the existing provider fixture follows its original
behavior. Foreman CI must exercise that default protocol through conformance's
public subprocess behavior and run the TS-target native qualification. The frozen
API unit suites are not a prerequisite, and no passing result is claimed here.

Scenarios may install `turn-scripts.json` in the returned `codexDirectory` using
`installCodexScripts`. Each `{id, includes, turns}` script matches a substring of
the delivered native prompt. Its successive turns are reserved atomically across
provider processes and API restarts; the last scripted turn repeats. Optional
`excludes` lists prompt fragments that must be absent. A graph task can exclude
its interval-check prompt because a fresh check contains both fragments.
Ambiguous selectors still fail the native turn; array order is never priority.
A scenario always begins with fresh counters.

A turn may supply `answer`, `jsonAnswer`, a real native `failure`, or a
`holdUntilFile` control filename. Holds remain interruptible and read only the
owned `codexDirectory/control` directory. Native `tools` execute in order, through
the actual declared callback. Each tool has `name`, `arguments`, and an optional
`saveAs` binding. An object such as `{"$ref":"copy/value/artifactId"}` resolves
against the exact parsed JSON in the tool response's first `inputText` item. Path
tokens use RFC 6901 escaping; there is no additional `json` wrapper. Missing
bindings fail the turn. Scripts cannot enable an undeclared tool, execute a shell
command, or turn a read-only native profile into a writable one.
The real callback enforces tool permissions; the fixture adds no tool-name cap.
An optional `codexErrorInfo: "internalServerError"` beside `failure` supplies that
native retry classification. Other classifications are rejected, and the actual
engine controls backoff and retry.

`mcpTools` uses the same `{name, arguments, saveAs}` shape and executes after
`tools`. Its result bindings are the exact parsed JSON from the real App MCP
response; structured content must agree with its JSON text. The two lists share
one binding map. The fixture uses conformance's pinned MCP SDK to initialize the
configured server, discover every tool page, and call the selected tool with the
credential actually delivered to that native process. It records the native
`mcpToolCall` item and its complete result, including actual tool failures.

The supported App connection is either this target's configured loopback `/mcp`
endpoint with its native bearer environment reference, or the current Node
runtime and this target's installed managed stdio launcher. The fixture does not
write route records, issue credentials, or substitute a private service call.
Native process and thread disable settings, configured tool policies, and actual
server authorization still apply. Each scripted turn closes its SDK transport,
and interruption cancels an in-flight request. Native work handoff/join scenarios
using this transport remain to be authored and exercised through Foreman CI;
this fixture increment alone claims no additional scenario coverage or pass.

Transport selection uses the effective native `command` or `url`, accepting the
CLI transport envelope and native whole-server or dotted thread overrides. A
transport change clears the old transport's locator and credential fields while
preserving tool and disable policies. The baseline provider fixture does not yet
implement configuration-layer ownership or `config/batchWrite`; native settings
mutation scenarios remain uncovered by this transport helper.

`interaction` emits `item/tool/requestUserInput` or
`item/commandExecution/requestApproval` with the supplied native `params`. The
actual public response is available as the `interaction` result binding, and a
declined command decision prevents subsequent tools. Thread and turn identifiers
come from the active native turn. Input responses are retained in native history.

`answerFromInput: "text"` returns the delivered native text. `"images"` returns an
array of actual image metadata records containing `type`, `mediaType`, `width`,
`height`, `pages`, `orientation`, `byteLength`, `sha256`, and `contentBase64`. The
scenario can independently decode those actual bytes and verify pixel semantics.
The fixture reads only
delivered local images under the isolated target directory or delivered inline
image bytes, without fetching URLs. Metadata uses conformance's pinned `sharp`
dependency; it does not simulate the product's image transformation.

## Claude

`claude-sdk/sdk.mjs` is a fake SDK package matching the required named exports of
`loadInstalledClaudeSdk(sdkEntrypoint)`. Pass the absolute returned
`claudeSdkEntrypoint` into that existing loader; the Go bridge must pass the same
path to its SDK loader. The adjacent package manifest is fixture metadata, not a
claim that an official SDK installation is present.

The SDK consumes the input async iterable, emits provider frames, preserves
history and fork identity in the explicitly supplied `CLAUDE_CONFIG_DIR`, and
supports interruption, mode changes and delivered MCP server changes. Its optional
`scripts.json` is an array of `{includes, answer, failure, waitForInterrupt, tools}`
scripts. Tool scripts go through the supplied `PreToolUse` and `canUseTool`
callbacks; delivered HTTP or SDK MCP servers execute their actual tool. HTTP
uses conformance’s pinned MCP client to initialize the selected server, retain
its session, enumerate all tool pages, and call only a discovered tool. The
configured endpoint and delivered credential must belong to this isolated target.
Every call closes its transport; MCP tool errors remain error tool results.
The fake never executes arbitrary shell commands. Its only built-in file operation
is `Write`, which creates a new bounded regular file beneath this target's generated
fixture scope after the declared tool's actual `PreToolUse` and `canUseTool`
callbacks allow it. Existing files, symlinks, paths outside the target and
sandbox-enabled writes fail; unsupported built-in tools fail explicitly.

The fake's deterministic native diagnostics remember the marker in the actual
persisted session, return queued reply markers, and perform the requested owned
Write. A diagnostic that explicitly requests a final answer after denial retains
the native error tool-result and then answers without another tool attempt. The
application still checks the real file contents, denied-file absence, callbacks,
history, resume, fork and native receipts and creates its own qualification.
Fixture responses never contain admission or qualification proofs.

At the source baseline Main's production composition does not forward
`sdkEntrypoint` through discovery and profile qualification, even though its
official SDK loader supports it. Worker qualification and inspection already
forward that parameter.
A query-only `claudeClient` injection cannot qualify a fresh profile. This remains
an explicit composition integration requirement for I/H; conformance does not
manufacture a qualification proof or weaken admission to work around it.

## Worker

`pairTestWorker` creates a new Ed25519 identity, requests a pairing grant through
the public management API, verifies the selected main's signed enrollment
challenge, and enrolls through the device TLS listener. `connectTestWorker`
verifies the signed WebSocket negotiation and handles real framed extension
requests, chunks, acknowledgements, cancellation and heartbeat traffic.

Each extension requires an explicit handler. `remoteExecutionExtension` parses
the shared current remote RPC contract and rejects a request for another worker
or immutable placement before calling the test script. Unsupported operations
return a real error envelope. The client does not manufacture installed-worker
bundle readiness, native entry receipts or successful remote operations.

`createTestWorkerRoots` exposes the existing `workspace-roots-v1` protocol for
pairing-managed temporary storage. Configuration contains actual descriptor,
inode and mount identities. Directory browsing performs real component-safe
filesystem reads, excludes files and symlinks, and returns the shared bounded
result. The MCP scenario adopts that configuration, checks the real directory
contents, changes an owned directory, and repeats after Worker reconnect and Main
restart. Known native errors cross the carrier; unexpected fixture exceptions
fail the client instead of becoming a canned domain failure.

Native workflow execution still needs the matching installed-worker bundle and
its real execution receipts. This directory scenario makes no claim about that
remaining coverage. Root choice inventory, attestation, and root-location writes
also remain separate cases; this handler reports unsupported operations honestly.

The listener uses a freshly generated CA and leaf certificate. TLS verification
stays enabled, and the client uses the shared selected-CA contract. `openssl` is a
runtime prerequisite for fixture setup. Tests run only through Foreman CI MCP.
