# Placement read transport guards

This first increment ports the two HTTP read guards from
`apps/api/src/modules/placement/transports.ts` at the frozen fork TypeScript
reference `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`.

`ReadbackHTTP` applies `Cache-Control: private, no-store` and
`Vary: Authorization, Cookie` before calling the accepted-placement reader.
`ChoicesHTTP` applies the same policy and rejects a query containing
`workspaceId`, `workflowId`, or `nodeId`, even if its value matches the URL.
The public failure is HTTP 400, `RESOURCE_ID_MISMATCH`, with the unchanged
message `Placement choice scope must be supplied in the URL.`

The guards take the shared `httpserver.Handler`; they do not define domain
DTOs, authenticate callers, discover computers, read SQL, or register routes.
Their eventual handlers must use the generated contract export, the shared
management authentication boundary, live scoped authorization, and the
corresponding placement domain services. Authentication must run outside the
guards, as the frozen management pre-handler does, so invalid credentials
retain priority over route validation. The guards preserve the original
request and its context for those services.

## Integration gate

At base `7fa547058109519a99c904493c916662fde6a474`, the full repository tree has
no generated Go contract export. Actual placement/computer read services,
HTTP route registration, and Operator MCP tool registration remain pending.
The integrator owns shared generated contracts, HTTP authentication, and
composition. This increment adds no product route or capability by itself.
The matching Operator tools remain `run_node_placement_get` and
`workflow_node_placement_choices`; they must land with the read services.

In particular, authenticated placement discovery must retain the frozen
live permission recheck before and after external discovery. Accepted Run
readback must use persisted placement and authenticated worker observations;
current settings or dispatch intent cannot manufacture execution evidence.

## Verification

Three public HTTP tests contain 17 cases covering the two cache headers,
success/error replies, query scope rejection, encoded keys, malformed values,
and preservation of URL scope, configuration selection and caller headers.
They use an in-process `http.ServeMux` and the shared HTTP error boundary with
isolated fake readers. They do not open ports or access a database, state
directory, installation, or paired worker.

Tests, build, formatting, lint and conformance are authored or requested only;
none ran in the Web authoring environment. The terminal must dispatch affected
checks through Foreman CI MCP. A baseline compile failure caused by this new
package being absent does not establish pre-fix behavioral red evidence.

The existing impacted conformance ID is `http.authentication.computers`.
The pinned suite has no placement success, query-scope, cache-header, or
placement MCP readback scenario. Q-CONF owns those missing expectations.
No existing scenario is claimed to pass from this helper-only increment.
