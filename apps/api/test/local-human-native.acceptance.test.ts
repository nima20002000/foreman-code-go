import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { inheritedAgentEnvironment } from '../src/modules/harnesses/secrets.js'
import { nativeHttpIsolation } from './helpers/nativeHttpIsolation.js'

const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1' || process.env.RUN_ENG03_C_NATIVE_TESTS === '1'

describe.skipIf(!enabled)('installed Codex local-human isolation', { timeout: 180_000 }, () => {
  it('cannot approve a human gate or mutate settings by omitting or forging browser headers', async () => {
    await nativeHttpIsolation(async input => {
      const script = join(input.directory, 'http-requests.cjs')
      const report = join(input.directory, 'http-results.json')
      await writeFile(script, input.script, { mode: 0o600 })
      const prompt = `Run this shell command once, wait for it to finish, then reply DONE:
        ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} > ${JSON.stringify(report)}`
      let launchError: Error | undefined
      const owned = spawnOwnedStdioProcess({
        binary: harnessBinaries(process.env).codexBinary,
        args: ['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check',
          '--model', process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna',
          '-c', 'model_reasoning_effort="low"', prompt],
        cwd: input.directory,
        environment: { ...inheritedAgentEnvironment(), GRAPHQL_MCP_TOKEN: input.token },
        recovery: input.recovery,
        onError: error => { launchError = error },
      })
      owned.child.stdout.resume()
      owned.child.stderr.resume()
      const deadline = setTimeout(() => { void owned.close() }, 150_000)
      try {
        const outcome = await owned.closed
        if (launchError) throw launchError
        return { exitCode: outcome.exitCode, stdout: await readFile(report, 'utf8'), stderr: '' }
      } finally {
        clearTimeout(deadline)
        await owned.close()
      }
    }, process.env.ENG03_A_TEST_DATABASE_URL ?? process.env.WAVE25_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL)
  })
})
