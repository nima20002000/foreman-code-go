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

An opt-in adjacent `scripted-turns.cjs` extension handles the native qualification
Markdown task. It reads the exact revision through `files_read`, writes only the
named result in a writable native workspace within the fresh fixture directory,
and publishes through `files_publish_result`. Read-only profiles cannot write.
Without the adjacent extension, the existing provider fixture follows its original
behavior. CI must verify both the original fixture suite and the TS-target native
qualification; neither result is claimed before that CI run.

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
callbacks; delivered HTTP or SDK MCP servers execute their actual tool. The fake
never executes arbitrary shell commands or local file operations.

At the source baseline the production discovery and profile-qualification paths
do not forward `sdkEntrypoint`, even though the official SDK loader supports it.
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

The listener uses a freshly generated CA and leaf certificate. TLS verification
stays enabled, and the client uses the shared selected-CA contract. `openssl` is a
runtime prerequisite for fixture setup. Tests run only through Foreman CI MCP.
