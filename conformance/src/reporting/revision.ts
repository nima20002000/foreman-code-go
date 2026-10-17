import { runCommand } from '../runtime/commands.js'
import type { RunIdentity } from './types.js'

const COMMIT_SHA = /^[0-9a-f]{40}$/
export const BASELINE_SHA = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'

export async function readRunIdentity(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunIdentity> {
  const explicit = environment.CONFORMANCE_COMMIT_SHA
  const commitSha = explicit ?? await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, environment })
  const baselineSha = environment.CONFORMANCE_BASELINE_SHA ?? BASELINE_SHA
  if (!COMMIT_SHA.test(commitSha)) throw new Error('Conformance commit identity must be an exact lowercase Git SHA')
  if (baselineSha !== BASELINE_SHA) throw new Error(`Conformance baseline must remain ${BASELINE_SHA}`)
  return {
    repository: 'nima20002000/foreman-code-go',
    baselineSha,
    commitSha,
    commitSource: explicit === undefined ? 'git' : 'environment',
  }
}
