# Server registration

Only the composition root constructs infrastructure. A domain package exposes
`Register(*app.App)` and registers its HTTP routes, MCP tools, stream endpoints and
background services there. Composition adds one call to that function.

`app.New(app.Options)` returns `(*app.App, error)` without opening a listener or
contacting PostgreSQL. Options contain the shared config, database, logger,
independent database/checkpoint readiness probes, readiness timeout, and MCP
access implementation. `health.Register(application)` registers the operational
routes. An absent readiness probe reports unavailable; it is never replaced by a
successful stub.

| API | Responsibility |
| --- | --- |
| `App.Handle(pattern, httpserver.Handler)` | Registers a method/path such as `GET /api/workspaces/{workspaceId}`. The handler writes success and returns errors to the common envelope. |
| `App.RegisterStream(pattern, httpserver.Handler)` | Uses the same boundary for streams. Go's `http.ResponseController` can unwrap the response writer for flush and hijack. |
| `App.RegisterTool(*mcp.Tool, validator, mcp.ToolHandler)` | Requires a generated input validator and authorizes every call before validation and execution. The SDK checks schema metadata during registration. |
| `App.RegisterService(name, func(context.Context) error)` | Starts background work with `Serve`; it must stop on cancellation. Failures stop the app and reach its caller. |
| `App.Handler()` | Exposes the standard HTTP interface for in-process requests and public behavior tests. |
| `App.Serve(ctx, listener)` | Serves an already allocated listener, drains HTTP requests, then cancels background work. Infrastructure cleanup remains the composition root's job. |

Registration happens before serving. Domain input/output types and validators
must come from the schemas generated from `packages/contracts`; the transport
envelope maps here are not a second catalog of domain types. For HTTP success
values use `httpserver.WriteJSON`. For MCP success values use
`mcpserver.ToolResult`, which preserves the existing structured content and
256 KiB text-mirror threshold. Errors must retain private causes in
`domainerror.Error.Cause`, not public details.

## Readiness and errors

The routes are `/health/live` and `/health/ready`, and the persisted service label
remains `graphql-api`. Readiness checks database and checkpoints independently.
Concurrent probes share pending work. A non-cooperative probe times out without
queuing another probe while the first is still running. Readiness defaults to
2,000 ms and accepts only positive integer milliseconds fitting the original
32-bit timer limit.

HTTP failures preserve the DomainError status, code, message, optional details,
optional retry class, and a fresh UUID request ID. Unknown causes are redacted.
The database read/connection normalization and public failure classification
are shared with MCP. The code classification table is ported from
`apps/api/src/modules/devices/deviceApplicationError.ts`; it does not define
additional permissions.

## MCP access and protocol

The endpoint stays `/mcp`. `mcpserver.Access` authenticates before the body is
read and attaches the generated principal to a context derived from the HTTP
request. It also enforces the existing Host/Origin policy. `Visible` filters
discovery, while `Authorize` enforces the current policy on every tool call,
including calls to a known tool hidden from discovery. These functions are
integration points for the access port; they do not add grants, approvals, caps,
or a second permission model.

An absent access implementation rejects all MCP requests: missing credentials
receive `AUTH_REQUIRED`; supplied credentials receive `MCP_UNAVAILABLE` because
there is no service able to validate them. This is an explicit foundation gap,
not successful authentication. GET and DELETE authenticate and return the
existing 405 JSON-RPC body.

The official `github.com/modelcontextprotocol/go-sdk` is pinned at v1.7.0,
published 2026-07-28T13:09:53Z. Its supported empty `GetSessionID` option closes
each request's ephemeral session and keeps legacy negotiation available without
debug flags. Cancellation is linked to the HTTP request for legacy handlers too.
The exact TS v2 negotiated revision still needs a real pinned-TS observation;
the legacy `2025-11-25` HTTP test is authored, not executed evidence. The next
foundation slice must add principal-scoped cross-request
`notifications/cancelled` tracking and verify both targets' negotiation.

## Verification state

Public-interface tests cover health status and deadlines, shared pending probes,
HTTP envelopes/redaction, authenticated MCP discovery and denied writes, persisted
in-memory readback, and background/HTTP shutdown. They do not read source text or
assert private implementation state. Lifecycle tests allocate random loopback
ports and isolated HOME directories. No real database, installation, paired
worker, or deployed app is used.

The authoring environment has no Go executable or gofmt. Compilation, formatting,
unit tests, conformance and CI have not run here; the controller must run the
required gates on the integrated head. Exact TS negotiation, generated
validators/principals, shared access middleware and cross-request MCP cancellation
remain part of the following foundation slice.
