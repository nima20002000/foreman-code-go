import { mkdir, mkdtemp } from 'node:fs/promises'
import { ownedTestDatabaseUrl } from './testResources.js'
import { join } from 'node:path'
import { openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'

/** Private fixture bytes stay below the invocation's owned root. */
export async function privateFixtureDirectory(prefix: string): Promise<string> {
  ownedTestDatabaseUrl()
  const parent = join(process.env.GRAPHQL_TEST_ROOT!, 'private-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const handle = await openPrivateRoot(parent)
  await handle.close()
  return mkdtemp(join(parent, prefix))
}
