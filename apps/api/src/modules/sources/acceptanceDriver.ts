import { createHash } from 'node:crypto'
import type { SourceManifest, RootBinding } from '@foreman-code/contracts/source-materialization'
import { PrivateSourceMaterializer } from './materialization.js'
import type { MaterializationAttempt, SourceByteReader } from './ports.js'

/** W09-C/orchestrator inject the authenticated byte carrier and current W07/W08
 * authorization service. A filesystem-only invocation is preparation evidence,
 * not production/two-device acceptance.
 */
export async function runSourceMaterializationFixture(input: {
  manifest: SourceManifest; binding: RootBinding; attempt: MaterializationAttempt;
  reader: SourceByteReader;
  authorize: (binding: RootBinding, attempt: MaterializationAttempt) => Promise<void>;
}) {
  const service = new PrivateSourceMaterializer(input.reader, input.authorize)
  const receipt = await service.prepare(input)
  const root = await service.resolve(receipt, { binding: input.binding, attempt: input.attempt })
  return { receipt, root, manifestDigest: input.manifest.manifestDigest,
    entries: input.manifest.entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, byteSize: entry.byteSize })),
    receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') }
}
