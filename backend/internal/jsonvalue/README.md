# Lossless shared JSON values

This dependency leaf reads the JSON grammar used by the frozen TypeScript
runtime's native JSON.parse. It has no HTTP, contract, canonical encoder, DB,
worker, or configuration dependency. Authored source is not executed evidence.

## Public boundary

- Parse([]byte) (any, error) reads one UTF-8 JSON value with an iterative container
  stack and no newly imposed nesting/byte cap. The caller owns resource admission.
- ParseString([]byte) (UTF16String, error) uses the same string scanner.
- NumberFloat64(json.Number) (float64, error) validates a JSON number token and
  applies binary64 rounding. Valid overflow becomes infinity; finite/safe-integer
  rules belong to the source contract or RPC caller. Raw json.Number is a token
  representation, not evidence of JavaScript number validation equivalence.
- UTF16String preserves escaped lone surrogates. FromUTF8 and UTF8 make normal
  Go string conversion explicit; UTF8 returns ErrInvalidUTF16 when conversion
  would replace a code unit. CodePointCount follows JavaScript string iteration.
- UTF16String.IdentityKey() returns one injective big-endian UTF-16 unit key.
  It is opaque identity material, not display text, a token or JSON. Empty text
  has an empty key. Contracts.Text delegates to this same operation.
- Object and Member retain all string keys. Parse returns numeric array-index
  keys first, then other keys in their first insertion order, as Object.keys
  does. Later duplicate keys replace the value without moving that property.
  UTF16String.ArrayIndex holds the array-index-name rule shared with canonical
  numeric-key legacy ordering.

Parsed values are UTF16String, Object, []any, json.Number, bool and nil. Empty
containers are non-null containers. No invalid UTF-8 is silently replaced here.
The body adapter first applies its frozen transport UTF-8 replacement/BOM rules,
then calls Parse, and keeps secure-json-parse poison-key rejection in that layer.
Native JSON.parse itself accepts those property names, including __proto__.

canonicaljson aliases these string/object types and uses NumberFloat64, keeping
one numeric token grammar and one UTF-16 identity representation. Canonical
Graph's existing depth/byte/node restrictions are unaffected by the input
reader's deeper acceptance. LocaleOrderLegacy remains a separate open serializer.

## Actual reference gate is required

Terminal Foreman CI must run only the focused producer on the controller's actual
frozen baseline runner:

    node scripts/go-contracts/json-vectors.mjs <frozen-source-root> <isolated-output>/json-vectors.json

The producer verifies the frozen checkout and package source identity, records
the actual runner/engine and candidate producer identity, and calls native
JSON.parse without a reviver. It captures Object.keys order, exact UTF-16 units,
string code-point counts and actual binary64 bits in a flat event stream. Flat
events avoid recursive readback/stringify limits for the depth-10001 cases.
Nothing in this repository substitutes hand-authored expected outcomes.

Set JSON_VALUE_VECTORS_FILE to the actual retained artifact. In backend/, request:

    go test ./internal/jsonvalue -run '^(TestParseReferenceVectors|TestUTF16IdentityPreservesDistinctValues|TestParseRequiresNormalizedUTF8)$' -count=1

All 54 exact producer scenarios must exist, with no unexpected capture failures.
Missing, malformed or incomplete reference data fails, never skips. The tests
compare public parsing/number/string readbacks, not implementation source text.
The canonical alias/numeric delegation also requires only its six existing
affected current/graph/numeric tests and actual frozen fixtures. Access owns
the separate HTTP adapter/depth regression with its retained pre-fix candidate.

No test, producer, build, typecheck, lint or formatter ran in Web. The terminal
must retain actual source/candidate/tree identities, artifact SHA256 values and
CI ticket results before any consumer is qualified. No full suite is requested.

## Source basis

The baseline is 8d2ea76c5028ef4458bf8cd64ef8624422e71d9f, never refreshed. Its
apps/api/package.json defines Node entry commands; merged-base conformance uses
process.execPath and therefore inherits the actual terminal runner. The frozen
body boundary uses JSON.parse through lock-pinned secure-json-parse 4.1.0.
The standard's exact grammar and duplicate replacement behavior are documented
at https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse . Go's
binary64 rounding/range API is documented at https://pkg.go.dev/strconv#ParseFloat .
These documents guide source reading; only actual frozen-runner vectors prove
the candidate behavior for this migration.
