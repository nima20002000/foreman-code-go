# Shared canonical JSON

This package ports `canonicalJson`, bounded `canonicalGraphJson`, and
`canonicalJsonNumericKeysFirstLegacy` from `packages/contracts/src/canonicalJson.ts` at frozen reference
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. It has not been executed in Web.

## Public API

- `Canonical(value any) (string, error)` emits the current canonical format.
- `Graph(value any, maxBytes int64) (string, error)` emits complete bounded JSON;
  pass `DefaultMaxBytes` for the TypeScript default of 8 MiB.
- `NumericKeysFirstLegacy(value any) (string, error)` preserves existing numeric
  key identities. Array-index names from `0` to `4294967294` use numeric order
  before other UTF-16 ordered keys. Top-level undefined produces `"null"`.
- `Undefined` distinguishes a missing JavaScript value from JSON null. Canonical
  omits undefined object values and writes null for undefined array items.
  Top-level undefined returns `ErrUndefined`, representing TS's undefined result.
- `UTF16String` and `Object` preserve unpaired UTF-16 surrogate units in strings
  and object keys. Normal well-formed Go strings and string-keyed maps work
  directly. `Object` has unique keys; it is not a sequence with duplicate fields.

All numbers use JavaScript's IEEE-754 Number semantics, including Go integers and
`json.Number`. Large exact integers must not be hashed as if JavaScript preserved
their integer precision. Negative zero emits zero. Canonical emits null for
nonfinite values; Graph rejects them.

Objects sort keys by UTF-16 code units. Strings preserve JSON.stringify's escapes,
including lone-surrogate escapes, unescaped HTML, and unescaped U+2028/U+2029.
Graph enforces a maximum depth of 32, at most 100,000 visited values, and exact
UTF-8 output byte limits. Errors never return a truncated prefix.

Accepted Go values are nil, booleans, strings, supported numeric values,
string-keyed maps, arrays, slices, and the explicit types above. Nil maps/slices
mean empty containers. A nil interface means null. Structs, pointers, functions,
channels, and custom marshalers are not JSON values for this API. Convert domain
values at their generated JSON boundary before hashing. JavaScript-only getters,
symbols, sparse arrays, and prototypes cannot be expressed by these plain Go
containers; no accessor or custom marshaler is ever invoked.
Do not pass a generated presence/optional helper struct or `json.RawMessage`
directly. Decode raw JSON and use the generated contract's normalized JSON-value
boundary (maps, slices, strings, booleans, nil, and `json.Number`) before hashing.
Raw byte slices represent arrays of numbers to this API, not pre-encoded JSON.

## Required reference capture and affected checks

Terminal Foreman CI must first run this focused producer from the repository root:

    node --experimental-strip-types scripts/go-contracts/canonical-vectors.ts <isolated-output>/canonical-vectors.json

The script refuses a canonical TS source whose Git blob differs from the frozen
source. It records the reference, source blob, actual executable and runtime
versions, exposed engine/ICU information, and locale. The expected text and SHA-256 identities are produced by the imported TS
functions; no expected reference output is hand-authored. This capture is pending.

Set `CANONICAL_JSON_VECTORS_FILE` to the absolute produced file, then execute only
the affected package through terminal Foreman CI:

    go test ./internal/canonicaljson -run '^(TestCanonicalReferenceVectors|TestGraphReferenceVectors|TestCanonicalGoContainerRepresentations|TestCanonicalGoNumberRepresentations|TestGraphRejectsNonJSONGoValues)$' -count=1

The first two tests fail if the file is absent, malformed, or selects zero
reference outcomes. They never skip missing reference data. The other cases
assert public Go-value behavior and do not read implementation source.

Affected compile/vet/static analysis/formatting is limited to this package and
the single new fixture producer. No other Go package or conformance scenario is
claimed as executed or changed by this increment. No local check was run.

## Required numeric-key legacy capture

Terminal Foreman CI must also run the separate legacy producer mode:

    node --experimental-strip-types scripts/go-contracts/canonical-vectors.ts <isolated-output>/canonical-legacy-vectors.json --legacy

Set `CANONICAL_JSON_LEGACY_VECTORS_FILE` to that absolute artifact and request:

    go test ./internal/canonicaljson -run '^TestNumericKeysFirstLegacyReferenceVectors$' -count=1

The numeric test fails on missing or empty reference outcomes. The producer
captures nine `legacy.numeric.*` cases plus twelve `legacy.locale.*` cases.
Locale captures are evidence for the remaining implementation, not a passing Go
locale claim. The producer records actual executable/runtime versions, Bun
version/revision when present, exposed JavaScriptCore/ICU/CLDR/Unicode versions,
default collator options and locale environment, and the signs of a focused locale comparison
matrix. It always imports the same pinned TS source. Expected bytes and digests
come from those functions, including their undefined-value quirks.

The frozen `apps/api/package.json` defines Node entry commands. The merged-base
`conformance/src/runtime/target.ts` launches TS using the conformance runner's
`process.execPath`. Terminal capture must therefore use the actual selected
baseline runner. If that runner is Bun, invoke the producer with that same Bun
executable and retain its real version/revision; Node compatibility fields are
not the runner identity. A null engine version means the runtime did not expose
it, not that a guessed ICU or JavaScriptCore version has been qualified.

## Required locale-order format remains open

Do not replace any call to a frozen legacy serializer with `Canonical`.
`canonicalJsonLocaleOrderLegacy` is required by current runtime code and remains
unimplemented pending the focused terminal capture above:

- `packages/contracts/src/commandIdentityNode.ts` uses locale order for
  `commandInputHash`; `apps/api/src/modules/commands/postgres.ts` calls it for
  command payload receipts.
- `packages/contracts/src/resourceTelemetry.ts` uses locale order for
  `telemetryCanonical` and selector keys; the HTTP/MCP readback path in
  `apps/api/src/modules/resource-telemetry/readback/selector.ts` uses those bytes.
- `apps/api/src/modules/harnesses/codexPluginIdentity.ts` uses
  `NumericKeysFirstLegacy` order for current plugin catalog/source/artifact
  identities. Route that port to this explicit API after its terminal gate.

Go locale collation parity must not be inferred from a different collation
library or fitted to a captured finite comparison table. Step2 canonical
foundations remain open until that required format and the actual cross-language
CI evidence are complete.
