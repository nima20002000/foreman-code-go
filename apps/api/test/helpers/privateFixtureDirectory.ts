import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'

/** Heavy-job TMPDIR ancestors are shared; private fixture bytes use an owned parent. */
export async function privateFixtureRoot(): Promise<string> {
  const parent = join(homedir(), '.graphql-private-test-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const handle = await openPrivateRoot(parent)
  await handle.close()
  return parent
}

export async function privateFixtureDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(await privateFixtureRoot(), prefix))
}
