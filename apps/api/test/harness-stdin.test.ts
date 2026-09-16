import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type HarnessExecutionRequest, type HarnessConfiguration } from '@graphql/contracts'
import { expect, it } from 'vitest'

import { CodexAdapter } from '../src/modules/harnesses/codex.js'
import { OpenCodeAdapter } from '../src/modules/harnesses/opencode.js'
import { buildHarnessPrompt, MAX_HARNESS_PROMPT_BYTES } from '../src/modules/harnesses/prompt.js'

const configurations: HarnessConfiguration[] = [
  { harness: 'codex', model: 'test-model', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' },
  // The noninteractive fallback only supports native auto; routed cases are tested separately.
  { harness: 'opencode', model: 'opencode-go/test-model', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: true },
]

function request(harness: HarnessConfiguration, input: HarnessExecutionRequest['input'], directory: string): HarnessExecutionRequest {
  return {
    executionId: 'execution-stdin', runId: 'run-stdin', workspaceId: 'workspace-stdin',
    workflowNodeId: 'node-stdin', workingDirectory: directory, runtimeDirectory: directory, input,
    configuration: {
      id: 'configuration-stdin', workspaceId: 'workspace-stdin', agentId: 'agent-stdin', version: 1,
      prompt: { system: 'Use the supplied input.' }, assignedSkills: [], harness,
      contentHash: 'sha256:test', createdAt: '2026-09-14T00:00:00.000Z',
    },
  }
}

const fakeCli = `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes('--version')) console.log('1.0.0')
else if (args[0] === 'login') console.log('Logged in')
else if (args[0] === 'auth') console.log('OpenCode Go')
else if (args[0] === 'debug' && args[1] === 'models') console.log(JSON.stringify({models:[{slug:'test-model',supported_reasoning_levels:[{effort:'high'}]}]}))
else if (args[0] === 'models') console.log('opencode-go/test-model\\n{"max":{}}')
else if (args[0] === 'debug') console.log('{}')
else {
  if (args.some(arg => arg.length > 1000)) throw new Error('Prompt leaked into argv')
  if (args[0] === 'exec' && args.at(-1) !== '-') throw new Error('Codex stdin sentinel missing')
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    if (!input.includes('ACCEPTED INPUT FROM THE WORKFLOW')) throw new Error('Missing stdin prompt')
    if (input.includes('EXPECT_NATIVE_AUTO') && !args.includes('--auto')) throw new Error('OpenCode native auto flag missing')
    const text = String(Buffer.byteLength(input))
    if (args[0] === 'exec') {
      console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}))
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}))
    } else {
      if (input.includes('EXPECT_ROUTED_APPROVAL')) console.error('Warning: permission request rejected in noninteractive run')
      console.log(JSON.stringify({type:'text',sessionID:'test-session',part:{text}}))
    }
  })
}
`

for (const harness of configurations) {
  for (const kind of ['initial input', 'accepted predecessor result']) {
    it.skipIf(process.platform === 'win32')(`${harness.harness} sends large ${kind} through stdin`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'graphql-stdin-'))
      try {
        const binary = join(directory, 'harness.cjs')
        await writeFile(binary, fakeCli)
        await chmod(binary, 0o700)
        const text = 'x'.repeat(300_000)
        const input = kind === 'initial input' ? { text } : { previous: { result: { text } } }
        const execution = request(harness, input, directory)
        const adapter = harness.harness === 'codex' ? new CodexAdapter(binary) : new OpenCodeAdapter(binary)
        const result = await adapter.execute(execution, {
          signal: new AbortController().signal,
          onSession: async () => undefined,
          onEvent: async () => undefined,
        })
        assert.deepEqual(result, { outcome: 'succeeded', output: { text: String(Buffer.byteLength(buildHarnessPrompt(execution))) } })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
}

for (const harness of configurations) {
  it.skipIf(process.platform === 'win32')(`${harness.harness} qualifies and executes in the accepted project directory`, async () => {
    const toolDirectory = await mkdtemp(join(tmpdir(), 'graphql-cwd-tool-'))
    const projectDirectory = await mkdtemp(join(tmpdir(), 'graphql-cwd-project-'))
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'graphql-cwd-runtime-'))
    try {
      const binary = join(toolDirectory, 'harness.cjs')
      await writeFile(binary, `#!${process.execPath}
const expected=${JSON.stringify(projectDirectory)}
if(process.cwd()!==expected){console.error('wrong cwd:'+process.cwd());process.exit(42)}
const args=process.argv.slice(2)
if(args.includes('--version')) console.log('1.0.0')
else if(args[0]==='login') console.log('Logged in')
else if(args[0]==='auth') console.log('OpenCode Go')
else if(args[0]==='debug'&&args[1]==='models') console.log(JSON.stringify({models:[{slug:'test-model',supported_reasoning_levels:[{effort:'high'}]}]}))
else if(args[0]==='models') console.log('opencode-go/test-model\\n{"max":{}}')
else if(args[0]==='debug') console.log('{}')
else { process.stdin.resume(); process.stdin.on('end',()=>{
  if(args[0]==='exec') { console.log(JSON.stringify({type:'thread.started',thread_id:'cwd-session'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.cwd()}})) }
  else console.log(JSON.stringify({type:'text',sessionID:'cwd-session',part:{text:process.cwd()}}))
}) }
`)
      await chmod(binary, 0o700)
      const execution = { ...request(harness, {}, projectDirectory), runtimeDirectory }
      const adapter = harness.harness === 'codex' ? new CodexAdapter(binary) : new OpenCodeAdapter(binary)

      const result = await adapter.execute(execution, {
        signal: new AbortController().signal,
        onSession: async () => undefined,
        onEvent: async () => undefined,
      })

      expect(result).toEqual({ outcome: 'succeeded', output: { text: projectDirectory } })
      expect(runtimeDirectory).not.toBe(projectDirectory)
    } finally {
      await Promise.all([
        rm(toolDirectory, { recursive: true, force: true }),
        rm(projectDirectory, { recursive: true, force: true }),
        rm(runtimeDirectory, { recursive: true, force: true }),
      ])
    }
  })
}

it('rejects an oversized prompt with an explicit policy error', () => {
  assert.throws(
    () => buildHarnessPrompt(request(configurations[0]!, { text: 'x'.repeat(MAX_HARNESS_PROMPT_BYTES) }, '/tmp')),
    /8 MiB/,
  )
})

it.skipIf(process.platform === 'win32')('keeps native auto handling on the explicit opencode run fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-auto-'))
  try {
    const binary = join(directory, 'harness.cjs')
    await writeFile(binary, fakeCli)
    await chmod(binary, 0o700)
    const advanced = { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionHandling: 'native_auto' as const }
    const execution = request({
      harness: 'opencode', model: 'opencode-go/test-model', variant: 'max', nativeAgent: 'build',
      thinking: false, autoApprove: true, advanced,
    }, { text: 'EXPECT_NATIVE_AUTO' }, directory)
    await expect(new OpenCodeAdapter(binary).execute(execution, {
      signal: new AbortController().signal,
      onSession: async () => undefined,
      onEvent: async () => undefined,
    })).resolves.toMatchObject({ outcome: 'succeeded' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('refuses to route GraphQL approvals through the noninteractive run fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-routed-'))
  try {
    const binary = join(directory, 'harness.cjs')
    await writeFile(binary, fakeCli)
    await chmod(binary, 0o700)
    const execution = request({
      harness: 'opencode', model: 'opencode-go/test-model', variant: 'max', nativeAgent: 'build',
      thinking: false, autoApprove: false, advanced: DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
    }, { text: 'EXPECT_ROUTED_APPROVAL' }, directory)
    await expect(new OpenCodeAdapter(binary).execute(execution, {
      signal: new AbortController().signal,
      onSession: async () => undefined,
      onEvent: async () => undefined,
    })).rejects.toMatchObject({ result: { error: { code: 'OPENCODE_FALLBACK_APPROVAL_UNSUPPORTED' } } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
