# Go contract export

`export-schemas.mjs` exports selected **runtime Zod schemas from the shared
contracts**, using the package's pinned Zod 4.6.3 JSON Schema converter. It creates
no hand-copied DTOs. The frozen behavior reference remains
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`; the merged implementation base remains
`7fa547058109519a99c904493c916662fde6a474`.

These files are authored and have not been executed in Web. Generated Go types,
validators, shared rule declarations and reference producers belong to the
contract child. The current exporter depends on that child's `goContractRules.ts`
and the source-owned Id/principal metadata increment. Source review and generated
artifacts do not establish runtime parity. Actual terminal CI tickets must do so.

## Public export API

`exportContractSchemas({ modules, selected, source, ruleForCheck, moduleRoots })`
returns a version-1 manifest. `modules` is a `Map` from logical module names to
their runtime exports; `selected` is a nonempty array of exact
`module#ExportSchema` identities, or `{ module, export }` records. `source.reference`
must be the frozen reference. `ruleForCheck` is the accessor from the same
compiled `goContractRules.js` module instance used by the selected schemas.

The result contains separate inline `input` and `output` JSON Schema bodies for
each emitted schema, targeting Draft 2020-12. Local `$ref`/`$defs` remain local;
no external resource loader or network access is needed to compile them. Logical
schema IDs come from the selected source module/export names. The Go consumer
keeps direction names distinct, for example `ManagementPrincipalInput` and
`ManagementPrincipalOutput`, even where their present fields are identical.

Every selected ID appears in either `schemas` or `unsupported`. Each unsupported
entry includes its source ID and concrete path/code/detail diagnostics. Missing
exports and non-schema selections are recorded, not omitted. Duplicate selections
and malformed identities are rejected. `coverage` records discovered, selected,
emitted, unsupported and unselected IDs, non-schema exports, counts and the exact
module file roots inventoried. Discovery is scoped to those roots; mapping a
logical module to a narrow source file does not claim discovery of its full
package barrel or the entire contracts catalog.

## Preserve runtime semantics

The shared helper builds each supported TS check from one immutable declaration,
attaches that same declaration to the schema, and registers its exact check
object in a WeakMap. The exporter requires both identities. Arbitrary `.meta()`
claims, an additional unregistered `.refine()` or `.overwrite()`, and metadata
without the corresponding check are unsupported. Callback function text is never
examined or copied.

Currently supported source rules are:

- `trim`, applied before ordinary string constraints, emitted as
  `x-foreman-normalization` at the exact schema node.
- `conditionalPresence`, emitted as both JSON Schema conditionals and
  `x-foreman-refinements`, from the same source declaration. The rule preserves
  JavaScript truthiness, the discriminator/field and the original custom messages.

Consumers must implement these extensions or reject the selected root. Applying
plain JSON Schema to raw, unnormalized input would lose trim behavior. Unknown-key
stripping, defaults/prefaults/catches, arbitrary transforms/pipes/coercions,
unregistered refinements, record-key normalization and unrepresentable types are
reported as unsupported. They are not replaced with permissive schemas or local
Go repair predicates.

String length follows **Zod 4.6.3**, whose min/max/exact checks count Unicode code
points. Its internal UTF-16-unit check is only an early bound. JSON strings must
still preserve lone UTF-16 surrogates for source acceptance and serialized
readback; replacement with U+FFFD would change valid Id values. The manifest
records `lossless-utf16` separately from `unicode-code-points`. Generated Go Text,
decoder and canonical serialization support must prove this through the actual
shared reference vectors before a root is qualified.

Patterns retain the emitted source expression and carry
`x-foreman-regexp: ecmascript-no-flags`. JavaScript regexp flags are rejected when
conversion would discard them. No equivalence with Go RE2 is assumed: the Go
consumer must qualify or reject each expression and test the initial ASCII
date-time/UUID patterns through reference acceptance/readback cases. Formats are
annotations when the exact source pattern carries validation; a generic RFC3339
or UUID format assertion must not add restrictions absent from Zod. The initial
qualified-by-source-inspection format families are regex, UUID/GUID, date-time,
date and time. Other formats receive explicit unsupported diagnostics pending
their source-derived parity work.

`coverage.exported` counts emitted schema artifacts. It does **not** mean that Go
normalization, decoding, regexp validation, DTO generation or any runtime test has
passed. Runtime qualification requires the separate terminal evidence listed
below.

## Focused terminal commands

Run every command only through terminal-owned Foreman CI MCP. Use a fresh isolated
HOME/state/output area, no real database, ports, pairing, worker or installation.
The exporter opens no network connection and does not start a server.

First compile only the affected source graph rooted at
`packages/contracts/src/schemaPrimitives.ts` and
`packages/contracts/src/management/principals.ts`, including their shared
`goContractRules.ts` dependency, to `packages/contracts/dist`. Use the pinned
compiler and the existing project's required checks. The complete package barrels
are not required for this initial auth request. Retain the actual compilation
ticket and output identities; hashes alone cannot prove that compiled files match
the source.

Then capture exactly the initial auth roots:

    node scripts/go-contracts/export-schemas.mjs --module '.=dist/schemaPrimitives.js' --module './management=dist/management/principals.js' --select '.#IdSchema' --select './management#ManagementActionSchema' --select './management#ManagementGrantSchema' --select './management#ManagementPrincipalSchema' --output <isolated-output>/auth-schemas.json

The CLI requires exact committed source descending from the merged base, the
frozen reference object, no dirty shared source, and the pinned installed Zod
version. It records full candidate/tree/source-tree identities, the exporter and
compiled-root SHA256s, scoped inventory and diagnostics. Only the already-approved
source metadata edits in `goContractRules.ts`, `schemaPrimitives.ts` and
`management/principals.ts` are currently accepted relative to the frozen TS tree.
Any additional source change needs a source-preserving review and explicit scope
update; it is not a baseline refresh.

For an incomplete selection, the CLI still writes the complete coverage and
unsupported report and returns status 1. A configuration/provenance failure
returns status 2. Never treat a partial emitted subset, an old output file or a
zero-output command as a passing generation receipt.

Run the exact affected public exporter cases:

    node --test --test-name-pattern '^(schema-export\.(coverage|input-output-presence|missing-and-nonschema|duplicate-identities|frozen-reference|unsupported-runtime-behavior|forged-rule-metadata|shared-trim|normalization-check-order|record-key-normalization|shared-principal|source-patterns|local-recursion|conditional-source-check))$' scripts/go-contracts/export-schemas.test.mjs

These tests import the actual compiled shared helper, primitives and principal
schemas. They do not skip when those prerequisites are absent and do not inspect
implementation source text. Keep the contract child's focused TS reference
capture, generated Go type/validator checks and exact auth public vector IDs as
separate required CI evidence. No full repository suite or disguised full wrapper
is requested. Any required lint/typecheck applies only to the two exporter files
and the affected shared source dependency graph.

## Remaining catalog work

The initial capture selects four source roots. Before the source-owned helper
increment, static inspection finds unrepresented runtime behavior in three:
IdSchema (trim), ManagementGrantSchema (nested Id trim), and
ManagementPrincipalSchema (Id/name trim and the worker/agentId refinement).
ManagementActionSchema is a directly exportable enum. The helper increment
provides the exact shared rule declarations for those three roots; terminal
capture still has to prove they export and validate without loss.

ServiceHealthSchema in the root barrel is directly representable but is not part
of this narrow auth capture. ApiErrorSchema and ApiErrorResponseSchema remain
blocked by their own unregistered `code`/`message` trims even after Id metadata is
available. The larger catalog also uses defaults, refinements, transforms and
strip behavior. The exporter reports these per selected root; this increment
makes no full-catalog completion claim. Further source-owned adapters and explicit
public parity evidence remain required, without hand-copied Go DTOs.
