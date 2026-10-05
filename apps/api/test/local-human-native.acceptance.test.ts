import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { signalTree, spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { inheritedAgentEnvironment, redactSecretText } from '../src/modules/harnesses/secrets.js'
import { nativeHttpIsolation, type NativeHttpIsolationInput } from './helpers/nativeHttpIsolation.js'

const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1' || process.env.RUN_ENG03_C_NATIVE_TESTS === '1'

describe.skipIf(!enabled)('installed harness local-human isolation', { timeout: 180_000 }, () => {
  it.each(['codex', 'opencode'] as const)(
    '%s protects human HTTP from a terminal-launched restricted MCP client without a registry or credential marker', async harness => {
    await nativeHttpIsolation(async input => {
      const { script, report } = await installProbe(input)
      const environment = inheritedAgentEnvironment()
      delete environment.FOREMAN_CODE_MCP_TOKEN
      const binaries = harnessBinaries(process.env)
      const codexArguments = [
        'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', process.env.CODEX_TEST_MODEL ?? 'gpt-6-luna',
        '-c', 'model_reasoning_effort="medium"',
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
      const { script, report } = await installProbe(input)
      let launchError: Error | undefined
      let diagnostics = ''
      let transcript = ''
      const owned = spawnOwnedStdioProcess({
        binary: harnessBinaries(process.env).codexBinary,
        args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check',
          '--model', process.env.CODEX_TEST_MODEL ?? 'gpt-6-luna',
          '-c', 'model_reasoning_effort="medium"',
          '-c', `mcp_servers.isolation.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.isolation.args=${JSON.stringify([script])}`, 'Reply DONE.'],
        cwd: input.directory,
        environment: { ...inheritedAgentEnvironment(), FOREMAN_CODE_MCP_TOKEN: input.token },
        recovery: input.recovery,
        onError: error => { launchError = error },
      })
      owned.child.stdout.on('data', chunk => { transcript = (transcript + String(chunk)).slice(-4_000) })
      owned.child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4_000) })
      // Codex exec consumes piped prompt input until EOF before starting its MCP clients.
      owned.child.stdin.end()
      const deadline = setTimeout(() => { void owned.close() }, 150_000)
      try {
        const outcome = await owned.closed
        if (launchError) throw launchError
        const safeDiagnostics = redactSecretText(`${diagnostics}\n${transcript}`, [input.token])
        if (outcome.exitCode !== 0) throw new Error(`Contained Codex exited before probe completion: ${safeDiagnostics}`)
        let stdout: string
        try { stdout = await readFile(report, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          throw new Error(`Contained Codex did not complete its MCP startup probe: ${safeDiagnostics}`, { cause: error })
        }
        return { exitCode: outcome.exitCode, stdout, stderr: safeDiagnostics }
      } finally {
        clearTimeout(deadline)
        await owned.close()
      }
    }, process.env.ENG03_A_TEST_DATABASE_URL ?? process.env.WAVE25_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL)
  })
})

/** Probe from the real harness's MCP child before initialization completes. */
async function installProbe(input: NativeHttpIsolationInput) {
  const script = join(input.directory, 'native-mcp-probe.cjs')
  const report = join(input.directory, 'native-mcp-results.json')
  const probe = input.script.replace('process.env.FOREMAN_CODE_MCP_TOKEN', JSON.stringify(input.token))
  await writeFile(script, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    let complete = false;
    console.log = value => {
      fs.writeFileSync(${JSON.stringify(`${report}.tmp`)}, value, {mode:0o600});
      fs.renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
      complete = true;
    };
    ${probe}
    readline.createInterface({input:process.stdin}).on('line', line => {
      void (async () => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === 'initialize') {
          while (!complete) await new Promise(resolve => setTimeout(resolve, 20));
        }
        const result = message.method === 'initialize'
          ? {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolation',version:'1'}}
          : {tools:[]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
  `, { mode: 0o600 })
  return { script, report }
}
