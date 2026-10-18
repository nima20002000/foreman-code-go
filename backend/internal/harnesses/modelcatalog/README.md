# Native Codex model catalog reads

This package ports the native metadata read from the frozen TypeScript
`apps/api/src/modules/harnesses/codexModelCatalog.ts` at
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f` (blob
`443d4c2c2898ad8f74ec6a123bd30fb94b87d2ed`). It is the next ready portion of
NIM-2906 Step 1 child 3. Its delta starts at merged fork commit
`172326db82a5a792f970bf6d2f858e6dd17bf8f5`, tree
`a929469af51d1f36baa395cba305e11a0fa68a92`.

## Public native boundary

- `ParseCodex(CommandResult)` validates a native catalog command's result and
  returns `jsonvalue.Object`. It retains unknown native properties, exact
  JavaScript string identities and the optional native catalog-source marker.
- `ReadCodex(context.Context, Inspection, directory, environment)` reads the
  complete native `model/list` catalog through the existing generated Go
  client. It publishes a result only after installation recheck, successful
  cleanup and the caller's final cancellation check.
- `Error` preserves native failure code, message, retryability and wrapped
  cause. `CleanupError` exposes the fixed aggregate message and retains both
  inspection and cleanup causes without putting private cause text in that
  aggregate's public message.

Native catalog output is **not** `HarnessOptions`, `ProviderAccountModels`,
an account observation, a capability/admission receipt, or a schema002/shared
DTO substitute. The package does not implement those schemas, map those domain
responses, register HTTP/MCP routes or change application startup.

### Behavior

The reader checks installation identity, strips controller secrets from a fresh
copy of the supplied owning-host environment, and runs only the native MCP
configuration read (`mcp list --json`) before opening the metadata session.
Invalid or unavailable MCP inspection fails closed. Only configured
`foreman-code`, `graphql`, `graphql-app` and `graphql-operator` native entries
are disabled; unrelated entries remain available. Native callbacks receive
`-32601` and `Model inspection cannot answer native requests.`

Every generated `model/list` request includes hidden models and a limit of 100.
The reader preserves page order, projects frozen native metadata, rejects
repeated continuation cursors and empty continuation pages, and accepts at
most 10,000 models. A slug is nonempty and at most 1,024 UTF-16 code units;
duplicate slugs are invalid. Empty reasoning arrays, duplicate efforts/tiers
and whitespace strings keep their frozen meaning. Omitted speed tiers are
valid; explicit null is invalid. A complete result is never silently filtered
or replaced with a fallback model.

The standalone parser uses the existing shared `jsonvalue` implementation for
lossless JSON strings and unknown fields. The typed reader consumes the
existing generated `protocol.V2ModelListResponse`; native decoding, including
its existing Go-string representation, remains the retained Codex boundary.
This slice does not claim a new lossless native protocol decoder.

Cleanup runs after a successful open, including a failed `Start` or model read.
Close failure prevents publication. A simultaneous inspection failure retains
both errors under `Native model inspection and cleanup failed.` Cancellation
during successful cleanup returns `context.Cause`, retaining a caller-supplied
cause. Refresh warnings received while closing still mark a valid catalog
`cached`; warnings neither expose stderr nor hide an invalid catalog.

## Required production wiring

`Inspection` deliberately requires explicit owning-runtime adapters:

1. `AssertUnchanged` binds the check to the selected, qualified native binary.
2. `RunCommand` runs the supplied command in the supplied host context and
   completes its owned process cleanup before returning.
3. `Open` applies the supplied environment, native MCP exclusions, callback
   rejection and refresh-warning hook; it acquires but does not initialize the
   transport. A failed open cleans its partially acquired resources itself.
4. `Session.Start` uses the actual installation's qualified `codex.Protocol`.
5. Production `Session.Close` must drain late stderr and confirm physical
   process exit, including guardian/recovery ownership. A bare
   `codex.Transport.Close` closes streams and is insufficient for that duty.

These adapters, generated shared DTO/schema002 output blocked by the I-owned
memoizer export defect, domain translation/registration, provider-account
reads and the full Step 1 public scenarios remain unresolved dependencies.
No generated contracts are hand-copied here. Qualification, account admission,
real native launches, guardian/MCP launcher helpers and subsequent Step 2/3
work keep their original ownership and order.

The owner decisions remain Codex 0.154.0 through native Go JSON-RPC, permanent
thin Node bridge for official Claude SDK 0.3.284, and Go 1.27.2. Existing
qualified Codex, Claude, queue, discovery and generated postimages are
unchanged by this package.

## Terminal-only verification

All source and tests in this slice are authored/static-reviewed only until the
terminal's Foreman CI results arrive. No test, build, vet, formatting, lint,
typecheck, code generation, process execution or capture runs in the Web/local
authoring environment.

The standalone parser and fake native-session tests exercise public function
results, diagnostics, caller cancellation, observed port effects and cleanup.
The in-memory native fixture uses the retained real `codex.Transport` and
generated `ListModels` client. It starts no OS process or inference thread and
does not qualify a real installation or prove production process cleanup.

The package did not exist at the merged base. Its new-feature checks therefore
have no claimed pre-base assertion-red run. The first intermediate reader
discarded a custom cancellation cause after cleanup. Its actual production
commit `860f0bbd8eeac27a46955f2661f4c04fe0154de0` and test-only witness
`daee0e94f524c168318b64d2a318588cb802ac4a` are retained. The witness adds only
`TestReadCodexPreservesCancellationCauseAfterCleanup`. It is authored and
unexecuted: only a genuine reached assertion failure counts as its intended
old result, never a compilation/setup failure.

The ZIP handoff supplies exact affected test roots, build/vet/Staticcheck
package, changed-file formatter argv, witness/candidate identities and
isolated execution context. It requests no previously qualified H suites,
Python/codegen checks or unchanged queue cases. Existing historical cleanup
failures remain historical failures; later successful cleanup is a separate
receipt. Full H Step 1 and lane completion remain open.
