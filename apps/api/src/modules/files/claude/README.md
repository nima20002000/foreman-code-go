# Claude file MCP producer

`createClaudeFileMcpServer` creates an actual SDK-hosted MCP server using the
installed official Claude Agent SDK 0.3.284 `createSdkMcpServer` and `tool` APIs.
Pass its `server` as the `graphql-files` entry in the admitted query's
`mcpServers`; dispose `close()` with that native owner. Allocation is synchronous
and issues no credential. Call it only after profile/lifetime admission.

The common factory supplies the actual `AgentFileToolService`, a
`ClaudeFileAdmission` backed by the owner's existing accepted submission, a
`ClaudeFileCallResolver`, and the accepted harness `allowMutation` flag. The
resolver must obtain the exact observed native message ACK, session, principal,
client correlation, attempt, generation, and tool-use identity from trusted
provider evidence. Tool arguments cannot provide identity. Children are denied.
The existing Claude bridge and file domain service authorize every effect using
the current owner/grants and conversation lineage; no administrator write port,
new credential store, or app MCP grant is involved.

## Current provider evidence boundary

The installed SDK `sdk.d.ts` declares the tool handler as `(args, extra: unknown)`.
`SDKControlMcpMessageRequest` declares only `subtype`, `server_name`, and the
JSON-RPC `message`. The installed `sdk.mjs` `mcp_message` branch forwards that
message to the registered SDK transport. Neither boundary declares a native
session/message/tool-use/child identity or a correlation with `canUseTool`.
MCP request IDs alone are not native message or tool-use IDs. A last callback or
locally planned UUID cannot fill this gap. Until a caller has positive provider
evidence for that exact MCP invocation, its resolver must return `undefined`;
the server returns `CLAUDE_FILE_NATIVE_CONTEXT_REQUIRED` before issuance or file
effects. This module deliberately does not claim a live production qualification.

Focused verification uses the actual SDK server and MCP transport with the
existing in-memory file-domain service fixture. It covers bounded pinned reads,
Run provenance recording, live principal revocation/write denial, conversation
isolation, read-only discovery, missing ACK and child rejection.
