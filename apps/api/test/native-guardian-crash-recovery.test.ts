import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { identityAlive, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, readDetachedNativeProcess }
  from '../src/modules/harnesses/recovery/processRegistry.js'
import { readUntil } from './helpers/observableCondition.js'

const require = createRequire(import.meta.url)
const registryModule = new URL('../src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href
const owner = 'execution:guardian-crash-recovery'
const pendingRequest = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'original-thread' } }
const threadSettings = { 'original-thread': {
  model: 'fixture-model', reasoningEffort: 'high', cwd: 'fixture-project',
  approvalPolicy: 'never', sandbox: { type: 'readOnly' },
} }

const nativeSource = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')
const descendant = spawn(process.execPath, ['-e',
  'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
descendant.unref()
fs.appendFileSync('native-starts.jsonl', JSON.stringify({ pid: process.pid, descendantPid: descendant.pid })+'\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync('native-inputs.jsonl', line+'\\n')
  const message = JSON.parse(line)
  if (message.method === 'thread/start') {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: 'original-thread' }, model: 'fixture-model', reasoningEffort: 'high',
      cwd: 'fixture-project', approvalPolicy: 'never', sandbox: { type: 'readOnly' },
    } }))
  }
  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'original-turn' } } }))
    console.log(JSON.stringify(${JSON.stringify(pendingRequest)}))
  }
})
setInterval(()=>{},1000)
`

const managerSource = `
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { NativeProcessRegistry, spawnNativeProcess, attachDetachedStdio }
  from ${JSON.stringify(registryModule)}
const [directory, mode, readyFile] = process.argv.slice(2)
const registry = new NativeProcessRegistry(join(directory, 'registry'))
const scope = registry.scope(${JSON.stringify(owner)})
let stream
let settings
if (mode === 'original') {
  const child = spawnNativeProcess(process.execPath, [join(directory, 'native.cjs')], {
    cwd: directory, env: {}, recovery: scope, restartDetachable: true, reconnectableStdio: true,
  })
  child.stderr.pipe(process.stderr)
  child.once('exit', () => process.exit(1))
  stream = child.stdout
  child.stdin.write(JSON.stringify({ id: 'thread', method: 'thread/start' })+'\\n')
  child.stdin.write(JSON.stringify({ id: 'turn', method: 'turn/start' })+'\\n')
} else {
  const attached = await attachDetachedStdio(scope)
  stream = attached.socket
  settings = attached.threadSettings
}
let buffer = ''
stream.setEncoding('utf8')
stream.on('data', chunk => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end+1)
    if (message.method !== 'item/tool/requestUserInput') continue
    const launch = registry.snapshot().launches.find(item => item.owner === scope.owner)
    writeFileSync(readyFile+'.pending', JSON.stringify({ launch, request: message, settings }))
    renameSync(readyFile+'.pending', readyFile)
  }
})
stream.resume()
setInterval(()=>{},1000)
`

async function killManager(manager: ChildProcess): Promise<void> {
  if (manager.exitCode !== null || manager.signalCode !== null) return
  const exited = once(manager, 'exit')
  manager.kill('SIGKILL')
  await exited
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

it('survives original and repeated observer SIGKILL without replaying native work, then explicitly closes its tree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-guardian-crash-'))
  const registry = new NativeProcessRegistry(join(directory, 'registry'))
  const scope = registry.scope(owner)
  const managers: ChildProcess[] = []
  writeFileSync(join(directory, 'native.cjs'), nativeSource)
  writeFileSync(join(directory, 'manager.mjs'), managerSource)
  async function startManager(mode: string) {
    const readyFile = join(directory, `${mode}-ready.json`)
    const manager = spawn(process.execPath, ['--import', require.resolve('tsx'),
      join(directory, 'manager.mjs'), directory, mode, readyFile], { env: {}, stdio: ['ignore', 'ignore', 'pipe'] })
    managers.push(manager)
    let errors = ''
    manager.stderr!.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
    const ready = await readUntil(async () => {
      try {
        return JSON.parse(readFileSync(readyFile, 'utf8')) as {
          launch: NonNullable<ReturnType<typeof readDetachedNativeProcess>>
          request: typeof pendingRequest
          settings?: typeof threadSettings
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (manager.exitCode !== null || manager.signalCode !== null) {
          throw new Error(`Native fixture manager exited before becoming ready: ${errors}`)
        }
        return undefined
      }
    }, value => value !== undefined, { timeoutMs: 10_000, description: `${mode} native observer readiness` })
    return { manager, ready: ready! }
  }
  try {
    const original = await startManager('original')
    expect(original.ready.request).toEqual(pendingRequest)
    expect(original.ready.launch.lifecycle).toBe('active')
    const starts = readJsonLines(join(directory, 'native-starts.jsonl'))
    expect(starts).toHaveLength(1)
    const descendant = processIdentity(Number(starts[0]!.descendantPid))!
    expect(identityAlive(descendant)).toBe(true)
    await killManager(original.manager)
    await readUntil(async () => readDetachedNativeProcess(scope), launch => launch !== undefined,
      { timeoutMs: 3_000, description: 'original IPC crash detachment' })
    for (const mode of ['observer-first', 'observer-second']) {
      const observer = await startManager(mode)
      expect(observer.ready.request).toEqual(pendingRequest)
      expect(observer.ready.settings).toEqual(threadSettings)
      expect(observer.ready.launch).toMatchObject({
        launchId: original.ready.launch.launchId,
        guardian: original.ready.launch.guardian,
        provider: original.ready.launch.provider,
        boundary: original.ready.launch.boundary,
      })
      await killManager(observer.manager)
    }
    const final = await startManager('observer-final')
    expect(final.ready.request).toEqual(pendingRequest)
    expect(final.ready.settings).toEqual(threadSettings)
    expect(readJsonLines(join(directory, 'native-starts.jsonl'))).toEqual(starts)
    expect(readJsonLines(join(directory, 'native-inputs.jsonl'))).toEqual([
      { id: 'thread', method: 'thread/start' }, { id: 'turn', method: 'turn/start' },
    ])
    expect(await registry.closeOwner(owner)).toBe(true)
    expect(identityAlive(original.ready.launch.guardian!)).toBe(false)
    expect(identityAlive(original.ready.launch.provider!)).toBe(false)
    expect(identityAlive(descendant)).toBe(false)
  } finally {
    await Promise.all(managers.map(killManager))
    const closed = await registry.closeOwner(owner)
    if (!closed) throw new Error('Native crash fixture tree closure remains unconfirmed.')
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)
