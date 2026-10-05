import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { signalTree, spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { inheritedAgentEnvironment } from '../src/modules/harnesses/secrets.js'
import { nativeHttpIsolation } from './helpers/nativeHttpIsolation.js'

const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1' || process.env.RUN_ENG03_C_NATIVE_TESTS === '1'

describe.skipIf(!enabled)('installed harness local-human isolation', { timeout: 180_000 }, () => {
  it.each(['codex', 'opencode'] as const)(
    '%s protects human HTTP from a terminal-launched restricted MCP client without a registry or credential marker', async harness => {
    await nativeHttpIsolation(async input => {
      const script = join(input.directory, 'independent-mcp.cjs')
      const report = join(input.directory, 'independent-results.json')
      const probe = input.script.replace('process.env.GRAPHQL_MCP_TOKEN', JSON.stringify(input.token))
      await writeFile(script, `
        const fs = require('node:fs');
        const readline = require('node:readline');
        console.log = value => {
          fs.writeFileSync(${JSON.stringify(`${report}.tmp`)}, value, {mode:0o600});
          fs.renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
        };
        ${probe}
        readline.createInterface({input:process.stdin}).on('line', line => {
          const message = JSON.parse(line);
          if (message.id === undefined) return;
          const result = message.method === 'initialize'
            ? {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolation',version:'1'}}
            : {tools:[]};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
        });
      `, { mode: 0o600 })
      const environment = inheritedAgentEnvironment()
      delete environment.GRAPHQL_MCP_TOKEN
      const binaries = harnessBinaries(process.env)
      const codexArguments = [
        'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna',
        '-c', 'model_reasoning_effort="low"',
        '-c', `mcp_servers.isolation.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.isolation.args=${JSON.stringify([script])}`,
        'Reply DONE.',
      ]
      const openCodeArguments = ['run', '--agent', 'plan', '--format', 'json', '--model',
        process.env.OPENCODE_TEST_MODEL ?? 'opencode-go/gpt-5.6-luna', 'Reply DONE.']
      if (harness === 'opencode') {
        environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          mcp: { isolation: { type: 'local', command: [process.execPath, script], enabled: true } },
          permission: { '*': 'deny' },
        })
      }
      const child = spawn(harness === 'codex' ? binaries.codexBinary : binaries.openCodeBinary,
        harness === 'codex' ? codexArguments : openCodeArguments,
        { cwd: input.directory, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => resolve())
      })
      let diagnostics = ''
      child.stdout.resume()
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4_000) })
      const deadline = Date.now() + 120_000
      try {
        while (Date.now() < deadline) {
          try { return { exitCode: 0, stdout: await readFile(report, 'utf8'), stderr: '' } }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Independent ${harness} exited before its MCP probe: ${diagnostics}`)
          }
          await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
        throw new Error(`Independent ${harness} did not initialize its MCP client.`)
      } finally {
        await signalTree(child, 'SIGKILL')
        await exited
      }
    }, process.env.ENG03_A_TEST_DATABASE_URL ?? process.env.WAVE25_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL)
  })

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
