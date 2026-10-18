# Shared access policy

This package owns the shared policy from frozen TS modules/access. Domain lanes
retain credential storage, live Worker bindings, current Operator authority,
interaction reviewer policy and chat ownership. Public principal, grant, action,
scope and identifier values come from the generated contracts package.

`NewPolicy(registry, clock)` requires the generated registry. `ParsePrincipal`
and `Snapshot` create private immutable authorization snapshots through generated
schema parsing. `Principal.Generated` returns detached generated values;
`Principal.IdentityKey` returns an opaque injective UTF16 key, never a bearer or
display string. `Resource` is an in-process request argument using generated
Optional/ID/Text values; it is not a serialized public DTO.

Operator execution uses `IsAuthorized` or `Require` with every actual resource
identifier. `HasAction` is a visibility check only. Worker execution uses
`WorkerScopesForAction`, `CanReadInteraction`, and `CanRespondToInteraction` with
the domain-supplied interaction authority. Complete execution dimensions remain
within each grant. `WorkerScopeSummary` is only for display. Approval-user
credentials use `CanUserInteract` and receive no other audience's authority.
`IntersectGrants` preserves the source cross-product and ordering while reducing
delegated authority against current grants.

## Source and execution gates

Fixed repository base: 7fa547058109519a99c904493c916662fde6a474. Frozen TS:
8d2ea76c5028ef4458bf8cd64ef8624422e71d9f. This source consumes the agreed generated
API, but no generated output or terminal execution is claimed. Required generated
roots include ManagementPrincipalSchema, ManagementGrantSchema and
ManagementActionSchema from packages/contracts/src/management/principals.ts.
The private audience enum is generated as ManagementPrincipalAudience. ID/IDs
initialisms are derived from source property keys; wire JSON retains those keys.
No generated file is fabricated in this consumer packet.

Actual generated registry/type production, source captures, dependency metadata,
compilation and the exact public policy cases require terminal Foreman CI MCP.
Missing generated symbols or setup failures are not behavioral regression evidence.
The private timestamp conversion runs only after generated Timestamp validation;
fraction/offset/year boundaries remain required frozen-TS versus Go evidence.

Authentication, injected OperatorSecurity composition, local-client process
attribution, and final domain-port wiring are subsequent shared-foundation slices.
There is no fallback credential, grant preset, persistence adapter or local-human
authorization in this pure policy checkpoint.
