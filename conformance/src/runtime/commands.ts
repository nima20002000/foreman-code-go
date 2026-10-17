import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const executeFile = promisify(execFile)
const LOG_LIMIT = 16_384

export interface CommandOptions {
  cwd: string
  environment: NodeJS.ProcessEnv
  timeoutMs?: number
  secrets?: readonly string[]
}

function redact(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]')
  return result
}

export class CommandError extends Error {
  constructor(message: string, readonly exitCode: string | number | undefined) {
    super(message)
    this.name = 'CommandError'
  }
}

function commandFailure(command: string, error: unknown, secrets: readonly string[] = []): CommandError {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const code = typeof value === 'string' || typeof value === 'number' ? value : undefined
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
  const detail = redact(stderr.slice(-LOG_LIMIT), secrets)
  return new CommandError(`${basename(command)} failed (${code ?? 'unknown'})${detail ? `: ${detail}` : ''}`, code)
}

export async function runCommand(command: string, arguments_: readonly string[], options: CommandOptions): Promise<string> {
  try {
    const result = await executeFile(command, [...arguments_], {
      cwd: options.cwd,
      env: options.environment,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    })
    return result.stdout.trim()
  } catch (error) {
    throw commandFailure(command, error, options.secrets)
  }
}

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface ManagedProcess {
  assertRunning(): void
  stop(mode?: 'graceful' | 'kill'): Promise<void>
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    // Each launched server owns a process group; its native children must end too.
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // ignore: the child may have exited between observing its state and signaling it.
  }
}

export function startProcess(command: string, arguments_: readonly string[], options: CommandOptions): ManagedProcess {
  const child = spawn(command, [...arguments_], {
    cwd: options.cwd,
    env: options.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let output = ''
  const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-LOG_LIMIT) }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  let exit: ProcessExit | undefined
  const finished = new Promise<ProcessExit>(resolve => {
    child.once('error', error => { exit = { code: null, signal: null, error }; resolve(exit) })
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit) })
  })
  function assertRunning(): void {
    if (!exit) return
    const status = exit.error?.message ?? exit.signal ?? exit.code
    const detail = redact(output.trim(), options.secrets)
    throw new Error(`${basename(command)} stopped before readiness (${status})${detail ? `: ${detail}` : ''}`)
  }
  let stopping: Promise<void> | undefined
  async function stopProcess(mode: 'graceful' | 'kill'): Promise<void> {
    signalProcess(child, mode === 'kill' ? 'SIGKILL' : 'SIGTERM')
    const stopped = await Promise.race([finished.then(() => true), delay(10_000, false, { ref: false })])
    if (!stopped) {
      signalProcess(child, 'SIGKILL')
      const killed = await Promise.race([finished.then(() => true), delay(5000, false, { ref: false })])
      if (!killed) throw new Error(`${basename(command)} did not stop after SIGKILL`)
    }
    // The parent may exit while a native descendant is still finishing.
    signalProcess(child, 'SIGKILL')
  }
  return {
    assertRunning,
    stop: (mode = 'graceful') => { stopping ??= stopProcess(mode); return stopping },
  }
}

export async function waitUntilReady(
  child: ManagedProcess,
  probe: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    child.assertRunning()
    if (await probe()) {
      child.assertRunning()
      return
    }
    await delay(100)
  }
  throw new Error(`${label} did not become ready within ${timeoutMs} ms`)
}
