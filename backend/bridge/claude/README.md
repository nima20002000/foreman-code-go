# Permanent Claude SDK bridge

This is the first Claude transport increment of NIM-2906. The SDK stays in Node;
Foreman session ownership, policy, persistence, and qualification belong in Go.
The bridge owns only SDK handles, their prompt streams, and outstanding protocol
correlation. It creates no admission receipts or native process-closure proofs.

`claude-bridge.mjs` loads the exact `@anthropic-ai/claude-agent-sdk` version
`0.3.284`. Its `initialize` request accepts the same absolute `sdkEntrypoint`
used by the frozen TypeScript loader, including the conformance fake package.
The adjacent manifest and required exports are inspected before the SDK is used.
Loading a fake package with that version is transport setup, not qualification.

## Ownership and integration

The caller launches one bridge process in one isolated profile environment and
connects its stdout/stdin to `claude.NewClient`. Go owns that process and its
native lifecycle. History helpers use the process's original profile environment;
the bridge never switches `process.env` between requests or accounts.

The current increment deliberately supplies no domain registration or production
composition. `backend/internal/harnesses/claude` uses raw SDK payloads and local
transport envelopes; it does not copy Foreman domain shapes. The next issue step
must use I's generated shared contracts for the Go session manager, callback
journal, compaction, admission, and profile-scoped session operations. It must
connect A2's real file-tools HTTP MCP endpoint and shared native process ownership.
These prerequisites must land before a production adapter can claim readiness.

The release artifact step must bundle this source as `claude-bridge.js` with the
controller's pinned esbuild setup and the official SDK. No generated bundle is
included in this source increment. Node is required only for Claude hosts.

## Wire protocol

Each UTF-8 line is one JSON-RPC 2.0 envelope. Go uses request IDs prefixed with
`g`; SDK callbacks use IDs prefixed with `b`. Responses preserve native payloads
and failures. Undefined SDK results become JSON `null`.

| Method | Parameters and result |
| --- | --- |
| `initialize` | `{sdkEntrypoint}`; returns the actual `sdkVersion`. |
| `query` | `{queryId, options, callbacks}`; creates one SDK async stream. |
| `query.input` | `{queryId, message}`; puts one opaque native user message in its prompt stream. |
| `query.endInput` | `{queryId}`; ends input after already offered messages. |
| `query.interrupt`, `query.close` | `{queryId}`; call the corresponding SDK control. |
| `query.setPermissionMode` | `{queryId, args:[mode]}`; retains the port's `default`/`plan` modes. |
| `query.getContextUsage`, `query.initializationResult`, `query.mcpServerStatus`, `query.setMcpServers` | `{queryId, args:[...]}`; preserve the SDK control result. |
| `getSessionInfo`, `getSessionMessages`, `forkSession`, `listSubagents`, `getSubagentMessages` | `{args:[...]}`; invoke the exact SDK export in this process profile. |
| `query.event` | Notification `{queryId,event}` with the original native frame. |
| `query.end` | Notification `{queryId,error?}`; ends the output stream after preceding frames. |
| `callback` | Bridge request `{queryId,name,args}`; Go answers with the callback result or error. |
| `callback.cancel` | Notification `{callbackId}`; cancels the corresponding Go callback context. |

An option value containing only `{"__foremanBridgeCallback":"name"}` is revived
as the corresponding Go callback. The query's `callbacks` array declares the
registered names. This transports both `canUseTool` and SDK hook callbacks,
including matchers and timeouts already present in SDK options. Only the native
AbortSignal is removed from callback arguments; its cancellation crosses the
wire separately. Missing callbacks and callback failures remain errors.

In-process `type:"sdk"` MCP configurations cannot cross a JSON pipe. The Go
file-tools endpoint must be supplied as an SDK `http` server configuration.
The bridge does not make a denied tool request permissive or add tool grants.

`Query.Send` reports acceptance into the bridge prompt stream only. The Go
session manager must still derive input delivery from native observation and
persist the original session/prompt/output identities before publication.
`Query.Close` requests SDK closure; `Client.Close` closes the pipes. Neither is
positive containment evidence for the native process or its descendants.

## Authored behavioral checks

All execution belongs to terminal-dispatched Foreman CI MCP. This increment has
not run a test, build, formatter, typecheck, or lint command in the web workspace.

Five ordinary Go tests cover concurrent request correlation, retained SDK errors,
output ordering while policy waits, callback cancellation without a successful
decision, active controls during callbacks, truncated frames, canceled query
creation, and a closed transport with a blocked writer. Three integration-tagged
tests start only an owned Node process with the existing conformance fake SDK:
stream/control/history/fork behavior, Go hook/tool callback round trips with a
denied file remaining absent, and interruption of an active native turn.

Integration fixtures are copied to each test's temporary directory before script
data is added. HOME, Claude, XDG and temporary state are isolated; the configuration
round trip uses a random local HTTP test port. No live provider, real installation,
application database, worker pairing, or credential is used.

The pinned conformance registry has `harness.claude-setup-options` and
`harness.claude-unconfigured`. Those scenarios do not invoke this standalone
bridge and cannot establish its query/callback behavior. Q-CONF owns the missing
public Claude execution/callback scenario; no expectation or scenario is changed
here. I must also forward `sdkEntrypoint` through Main discovery, qualification,
metadata, and query construction, as the conformance fixture already requires.
