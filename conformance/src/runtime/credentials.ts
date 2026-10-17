import { join } from 'node:path'
import { runCommand } from './commands.js'
import type { Target } from '../reporting/types.js'

export interface TestOperatorCredentials {
  operatorToken: string
  readOnlyOperatorToken: string
}

/** Use the product's public administrative CLI, before the API takes its runtime ownership lock. */
export async function issueTestOperatorCredentials(options: {
  target: Target
  repoRoot: string
  executable: string
  environment: NodeJS.ProcessEnv
}): Promise<TestOperatorCredentials> {
  const apiRoot = join(options.repoRoot, 'apps/api')
  const prefix = options.target === 'ts'
    ? ['--import', 'tsx', join(apiRoot, 'src/cli/operatorCredentials.ts')]
    : ['credential']
  const issue = async (access: 'manage' | 'read-only') => {
    const output = await runCommand(options.executable, [...prefix, 'issue', '--name', `Conformance ${access}`,
      '--audience', 'operator', '--access', access], {
      cwd: options.target === 'ts' ? apiRoot : options.repoRoot,
      environment: options.environment,
      secrets: [options.environment.DATABASE_URL ?? ''],
    })
    const token = /^Token \(shown once\): (\S+)$/m.exec(output)?.[1]
    if (!token) throw new Error('The isolated credential CLI did not return its one-time Operator token')
    return token
  }
  // These are existing manage/read-only presets in a new test database, not new product permissions.
  const operatorToken = await issue('manage')
  const readOnlyOperatorToken = await issue('read-only')
  return { operatorToken, readOnlyOperatorToken }
}
