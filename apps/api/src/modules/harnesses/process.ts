import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { NativeEventInput } from './port.js'

const MAX_STDERR_LENGTH = 1_000_000

export interface JsonlProcessOptions {
  binary: string
  args: string[]
  cwd: string
  signal: AbortSignal
  onSpawn(process: ChildProcess): void
  onEvent(event: NativeEventInput): Promise<void>
}

export interface JsonlProcessResult {
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stderr: string
}

function asEvent(line: string): NativeEventInput {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const payload = parsed as Record<string, unknown>
      return { type: typeof payload.type === 'string' ? payload.type : 'native_event', payload }
    }
  } catch {
    // Preserve malformed/non-JSON stdout as a native event instead of dropping it.
  }
  return { type: 'unparsed_stdout', payload: { text: line } }
}

export async function runJsonlProcess(options: JsonlProcessOptions): Promise<JsonlProcessResult> {
  const child = spawn(options.binary, options.args, {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  options.onSpawn(child)

  let eventChain = Promise.resolve()
  const emit = (event: NativeEventInput) => {
    eventChain = eventChain.then(() => options.onEvent(event))
    return eventChain
  }

  let forceKillTimer: NodeJS.Timeout | undefined
  const abort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    forceKillTimer.unref()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  const stderrPromise = (async () => {
    let stderr = ''
    const lines = createInterface({ input: child.stderr, crlfDelay: Infinity })
    for await (const line of lines) {
      if (stderr.length < MAX_STDERR_LENGTH) stderr += `${line}\n`
      await emit({ type: 'stderr', payload: { text: line } })
    }
    return stderr
  })()

  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.trim()) await emit(asEvent(line))
    }
    const [{ code, signal }, stderr] = await Promise.all([exit, stderrPromise])
    await eventChain
    return { exitCode: code, exitSignal: signal, stderr }
  } finally {
    options.signal.removeEventListener('abort', abort)
    if (forceKillTimer) clearTimeout(forceKillTimer)
  }
}

export async function runCommand(binary: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(binary, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const abort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { exitCode, stdout, stderr }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
