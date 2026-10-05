import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedTestPath } from './testResources.js'

export async function writeNativeAcceptanceEvidence(filename: string, value: unknown): Promise<void> {
  const file = ownedTestPath(join(process.env.ENG03_A_EVIDENCE_DIR!, filename))
  const report = JSON.stringify(value, null, 2)
  await writeFile(file, report, { mode: 0o600, flag: 'wx' })
  // Native launch filters this controller-only archive path along with all GRAPHQL_TEST_* values.
  const archive = process.env.GRAPHQL_TEST_EVIDENCE_ARCHIVE
  if (archive) {
    await mkdir(archive, { recursive: true, mode: 0o700 })
    await writeFile(join(archive, filename), report, { mode: 0o600, flag: 'wx' })
  }
}
