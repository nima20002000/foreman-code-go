# Generated shared contracts: authored boundary and terminal gates

This package is source-ready for the bounded initial roots listed below. It is
**not generated, compiled, executed or qualified by this Web handoff**.
`generated.go` and `schemas.json` must be produced by terminal Foreman CI from
the actual shared source exporter. They are deliberately absent here. Missing
generated source or fixture inputs are unmet setup, never behavioral regression
evidence. No external repository publication is included.

The frozen TypeScript reference is
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`; the exact merged Go base is
`7fa547058109519a99c904493c916662fde6a474`. The exporter records the terminal's
actual integrated candidate, tree, contracts tree, compiled module identities
and pinned Zod policy. These records are provenance, not qualification receipts.
The controller must independently verify actual Foreman CI tickets.

## Source roots and generated interfaces

| Explicit schema ID | Generated public type/helper |
| --- | --- |
| `.#IdSchema` | `ID = Text`, `ParseID`, `ValidateID`, `IDSchemaID` |
| `./management#ManagementActionSchema` | `ManagementAction`, source-derived string constants and parse/validate helpers |
| `./management#ManagementGrantSchema` | `ManagementGrant`, generated private-shape type `ManagementGrantScope` |
| `./management#ManagementPrincipalSchema` | `ManagementPrincipal`, generated `ManagementPrincipalAudience` enum |
| `./operationalFailures#OperationalFailureSchema` | `OperationalFailure`, generated status literal type and optional fields |

The generator derives declarations from the ordered source descriptors. There
is no Go field catalog or copied DTO definition. Exported property names retain
their original JSON spellings and source order. Go fields use ID/IDs initialisms:
`ID`, `AgentID`, `WorkspaceIDs`, `WorkflowIDs`, `RunIDs`, `MainIDs`, `DeviceIDs`,
`ApplicationInstallationIDs`, and `ProviderAccountIDs`. `ManagementGrant` has
`Actions []ManagementAction` and `Scope ManagementGrantScope`. Its scope's first
three lists are `Optional[[]ID]`; UUID lists are `Optional[[]Text]`.

The private principal audience generates `ManagementPrincipalAudience` with
`ManagementPrincipalAudienceOperator`, `ManagementPrincipalAudienceWorker`, and
`ManagementPrincipalAudienceUser`. These type spellings are authored generator
decisions; terminal-generated output and compiled public tests must establish
that the exact output is available before a lane imports it.

Every root receives `Parse<Type>(*Registry, json.RawMessage) (Type, error)` and
`Validate<Type>(*Registry, Type) error`. `NewGeneratedRegistry() (*Registry,
error)` embeds and admits only the generated selected manifest. Numeric schema
fields are Go `float64`, matching JavaScript Number, including negative zero.
Integer rules remain source validators; they do not silently narrow to a Go
machine integer. Operational optional field examples are `ElapsedMs
Optional[float64]`, `Attempt Optional[float64]`, and `DataAgeMs
Optional[Nullable[float64]]`.

## Lossless values, presence and transport composition

`Text` stores JavaScript UTF-16 units. Its zero value is the empty string.
`TextFromUTF16([]uint16)` clones every unit; `TextFromUTF8(string) (Text, error)`
requires valid UTF-8. `UTF16()` returns a copy. `UTF8() (string, error)` refuses a
lone surrogate with `ErrInvalidUTF16`; it never replaces one for display or
identity. `IdentityKey()` delegates to `jsonvalue.UTF16String.IdentityKey()`:
opaque, injective big-endian UTF-16 bytes, including the empty key. It is not a
display string, token or serialized ID. `Equal(Text)` compares exact units.

`Optional[T]` distinguishes omission from a value; `Some(value)` constructs a
present field and `Get() (T, bool)` reads it. `Nullable[T]` distinguishes null
from a non-null value; its zero value is null and `Present(value)` constructs a
non-null value. `Optional[Nullable[T]]` preserves missing/null/value. Generated
object fields use `omitzero`, and marshaling a missing standalone Optional fails.
Use a non-nil empty slice for an explicitly empty constructed JSON array.

Use the generated parse helper or `Registry.Decode`, not plain
`encoding/json.Unmarshal`, to enforce contracts. The registry validates first,
then fills a fresh generated value through the lossless decoder. Failure leaves
an existing destination unchanged; numbers do not pass through JSON.stringify
before typed assignment, so negative zero survives. A plain struct unmarshal
only provides Go's JSON decoding behavior and is not shared-schema validation.

HTTP/auth code owns transport selection. It can pass normalized `JSONBody`
bytes to `Registry.Parse`/`Decode`, or the read-only `ParsedJSONBody` leaf value
to `Registry.ParseValue`/`DecodeValue`. Contracts imports no transport package.
The value methods clone before trim and binary64 conversion, preserving cached
request inputs and caller-owned generated values.

The normalized generic boundary is `jsonvalue.UTF16String`, `jsonvalue.Object`
(ordered lossless `Member{Key, Value}`), `[]any`, `float64`, `bool` and `nil`.
Raw parser numbers (`json.Number`) are converted through the shared parser's
strict Number conversion before schema checks. Use normalized values directly
with `canonicaljson`, or call `contracts.JSONValue(generatedValue)` to honor
public JSON marshalers before canonicalization. Do not send Optional internals,
raw Go structs or `json.RawMessage` bytes directly to the canonical serializer.
`contracts.JSONValue` is the public Go JSON-marshaler boundary; it is not a
replacement parser for raw `jsonvalue.Object`/UTF16String graphs. Already parsed
graphs go directly to registry value methods or canonicaljson.

## Source validation and issue semantics

The runtime requires the exporter's explicit `zod-default-en` mode, source-bound
trim/conditional-presence declarations, actual ordered checks, wrapper order,
abort/default-length-when policy, strict object property order and pinned
English policy identity. Plain JSON Schema does not contain this information.
`ValidationError` exposes every `Issue` in source order, including full code,
path, message, expected/values/origin/pattern/bounds and other source fields.
Issue property paths and messages retain lone UTF-16 units.

Current supported source rules are strings, finite numbers, distinct ASCII
string enums/literals, strict objects, arrays, optional/nullable wrappers;
source-bound ECMAScript trim and principal conditional presence; code-point
length bounds; safe integer checks; inclusive/exclusive numeric bounds; and the
source's bounded flag-free positive-ASCII patterns. Unknown nodes, custom error
maps, prototype-observing declared property names, arbitrary ECMAScript regex
features and unsupported extensions fail admission explicitly.

The JSON Schema bridge uses
[`github.com/santhosh-tekuri/jsonschema/v6` v6.0.3](https://pkg.go.dev/github.com/santhosh-tekuri/jsonschema/v6@v6.0.3).
Terminal must capture authentic module metadata and Go sums. This handoff does
not add guessed checksums or substitute a validator. Draft 2020-12 format stays
annotation with the exact source pattern; generic RFC3339 validation is not
substituted for Zod datetime behavior. External schema loading is disabled.

After source validation, the library receives an internal predicate projection:
one unpaired unit becomes one non-ASCII code point. For the admitted code-point
length and positive-ASCII pattern language this preserves the tested predicate;
fixed enums and property names already matched their exact ASCII source values.
Original UTF-16 data is never changed, returned from this projection, or used
for identity. Actual frozen acceptance/issues/readback vectors must establish
this bridge for every initial root; a successful library boolean is insufficient.
Any source/library disagreement is `ErrSchemaDisagreement`, never a forged Zod
validation issue.

Unusual wrong-type objects can invoke JavaScript relational coercion through a
built-in length guard after an initial type issue. The runtime ports the JSON
primitive coercions used there, but exact engine-specific thrown messages for
prototype-shadowing objects remain explicitly unqualified. They are separate
errors, not fabricated portable Zod issues. No general record-key, recursive,
coercion/default/transform or full-catalog support is claimed by these five roots.

## Public execution gates

The retained auth producer captures **all 47** frozen and candidate safeParse
outcomes, including errors/readback, then fails on any mismatch or unexpected
throw. Forty-five inputs are directly JSON-representable and receive full Go
issue/readback and generated-type checks. Two retain their original TS outcomes
and have named public JSON-boundary assertions:

| Scenario | Preserved source expectation and Go boundary |
| --- | --- |
| `auth.id.undefined` | Actual safeParse(undefined) rejection remains captured. Native JSON.stringify has no root encoding. Go rejects absent JSON/non-JSON `undefined` before schema execution and refuses standalone missing Optional encoding. |
| `auth.principal.explicit-undefined-agent` | TS own undefined Agent subject remains visible in raw source readback. Observed JSON.stringify omits it; generated Go AgentID is absent and JSON readback matches that exact projection. Raw own-undefined parity through JSON is not claimed. |

Operational capture adds 38 actual frozen/candidate outcomes for required and
optional fields, finite/safe-integer limits, negative zero, equivalent spellings,
range overflow/underflow, exact datetimes, code-point length and issue order.
All source captures keep full actual source/tree/module/runtime identities and
require independently verified terminal compilation tickets.

The separate `contracts.codegen.codepoint-fixture` exports an actual pinned Zod
`z.string().max(1)` under a test-only root, captures six actual outcomes, and
writes a combined test manifest. Terminal runs the real generator on that
manifest in a separate isolated candidate, then the compiled public Go
`TestGeneratedCodePointLengthFixture`. It does not enlarge the production
contract catalog. The six cases cover empty, one/two BMP characters, one astral
pair and lone high/low surrogates. No expected outcomes are fabricated here.

CLI tests inspect public diagnostics/results only. Generated source text,
filenames and hashes are not behavioral qualification. Exact affected commands,
scenario IDs, regression states and artifact prerequisites are supplied in the
ZIP handoff. No tests, producers, generators, compilers, formatters or linters
were executed in Web. LocaleOrderLegacy canonicalization and full-catalog
generation remain separate open gates.

## Pinned implementation references

- [Shared primitives](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/packages/contracts/src/schemaPrimitives.ts), blob `244b75ca295c378f8083bcc348e2c934017a3e6c`.
- [Management principals](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/packages/contracts/src/management/principals.ts), blob `207fd2bc00afb2f4bac73dc7b2ad021e56368098`.
- [Operational failures](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/packages/contracts/src/operationalFailures.ts), blob `c65d6160be2ce1017d326501a48056a885aa85d5`.
- [Zod 4.6.3 core schemas](https://github.com/colinhacks/zod/blob/v4.6.3/packages/zod/src/v4/core/schemas.ts), blob `b210905e6fe738aed7ff4595e890e3b86d130c0d`.
- [Zod checks](https://github.com/colinhacks/zod/blob/v4.6.3/packages/zod/src/v4/core/checks.ts), blob `02383796bfb52e6bf9681a3c52aeadef599d8aab`.
- [Zod English errors](https://github.com/colinhacks/zod/blob/v4.6.3/packages/zod/src/v4/locales/en.ts), blob `3836bd1651071082fb24488d4e3b3d29db851134`.
- [Zod patterns](https://github.com/colinhacks/zod/blob/v4.6.3/packages/zod/src/v4/core/regexes.ts), blob `d9d608d124062b901ea3b8946cfcb14581536ec8`.
