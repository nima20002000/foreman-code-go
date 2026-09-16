import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { NativeEventInput } from './port.js'

const MAX_STDERR_LENGTH = 1_000_000
export const PROCESS_SHUTDOWN_GRACE_MS = 1_000
const ownedProcesses = new WeakMap<ChildProcess, () => Promise<void>>()

export interface JsonlProcessOptions {
  binary: string
  args: string[]
  cwd: string
  signal: AbortSignal
  stdin?: string
  onSpawn(process: ChildProcess): void
  beforeSpawn?(): Promise<void>
  onEvent(event: NativeEventInput): Promise<void>
}

export interface JsonlProcessResult {
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stderr: string
}

type ProcessOptions = Pick<JsonlProcessOptions, 'binary' | 'args' | 'cwd' | 'stdin' | 'beforeSpawn'> & {
  signal?: AbortSignal
  onSpawn?(process: ChildProcess): void
  environment?: NodeJS.ProcessEnv
}
type ProcessExit = Pick<JsonlProcessResult, 'exitCode' | 'exitSignal'>

export async function signalTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups. Kill the tree, not just its root.
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', reject)
      killer.once('close', (code) => {
        if (code === 0 || code === 128) resolve() // 128: the process already exited.
        else reject(new Error(`taskkill failed with exit code ${String(code)}.`))
      })
    })
    return
  }
  try {
    // A detached POSIX child leads a new group. Its descendants inherit that group.
    // The group can outlive the direct child, so never gate this on child.exitCode.
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Cancel through the same lifecycle used for aborts and reader failures. */
export async function stopProcess(child: ChildProcess): Promise<boolean> {
  const stop = ownedProcesses.get(child)
  if (!stop) return false
  await stop()
  return true
}

async function runOwnedProcess<T>(
  options: ProcessOptions,
  read: (child: ChildProcessWithoutNullStreams) => Promise<T>,
): Promise<T & ProcessExit> {
  options.signal?.throwIfAborted()
  const childEnvironment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env), NO_COLOR: '1' }
  for (const key of Object.keys(childEnvironment)) {
    if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_')
      || key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL' || key === 'PGPASSWORD'
      || key === 'GRAPHQL_APP_MCP_TOKEN') {
      delete childEnvironment[key]
    }
  }
  // No asynchronous work may separate the launch check from process creation.
  // This detects qualification-time replacement; it is not an atomic cwd pin.
  if (options.beforeSpawn) await options.beforeSpawn()
  options.signal?.throwIfAborted()
  const child = spawn(options.binary, options.args, {
    cwd: options.cwd,
    env: childEnvironment,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
  })
  const processError = new Promise<never>((_resolve, reject) => {
    child.on('error', reject)
  })
  // Observe errors immediately, including errors before any reader is started.
  void processError.catch(() => undefined)

  let shutdown: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (!shutdown) {
      shutdown = (async () => {
        let killError: unknown
        const send = async (signal: NodeJS.Signals) => {
          try { await signalTree(child, signal) } catch (error) { killError ??= error }
        }
        await send('SIGTERM')
        const timer = setTimeout(() => { void send('SIGKILL') }, PROCESS_SHUTDOWN_GRACE_MS)
        // Keep the timer and cancellation ownership until close confirms pipe cleanup.
        try {
          await closed
          // Also clean up descendants that closed stdio before the parent exited.
          await send('SIGKILL')
        } finally {
          clearTimeout(timer)
        }
        if (killError) throw killError
      })()
      void shutdown.catch(() => undefined)
    }
    return shutdown
  }
  const abort = () => { void stop() }
  ownedProcesses.set(child, stop)
  options.signal?.addEventListener('abort', abort, { once: true })
  // A root that exits normally must not leave descendants holding our pipes open.
  child.once('exit', abort)
  child.once('error', abort)

  const readers = Promise.resolve().then(() => read(child))
  const input = new Promise<void>((resolve, reject) => {
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Early CLI exits (including qualification failures) can close stdin.
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') resolve()
      else reject(error)
    })
    child.stdin.end(options.stdin ?? '', (error?: Error | null) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED') resolve()
      else reject(error)
    })
  })
  // Attach handlers to every concurrent task in the same turn that creates it.
  const tasks = Promise.all([readers, input, closed])
  const result = Promise.race([tasks, processError])
  void result.catch(() => undefined)
  try {
    options.onSpawn?.(child)
    if (options.signal?.aborted) abort()
    const [output, , exit] = await result
    return { ...output, ...exit }
  } catch (error) {
    await stop()
    await Promise.allSettled([readers, input, closed])
    throw error
  } finally {
    await stop()
    options.signal?.removeEventListener('abort', abort)
    ownedProcesses.delete(child)
  }
}

async function settleReaders<T>(child: ChildProcess, tasks: Promise<T>[]): Promise<T[]> {
  try {
    return await Promise.all(tasks)
  } catch (error) {
    await stopProcess(child)
    await Promise.allSettled(tasks)
    throw error
  }
}

async function readLines(stream: Readable, onLine: (line: string) => Promise<void>): Promise<void> {
  stream.setEncoding('utf8')
  let pending = ''
  for await (const chunk of stream) {
    pending += String(chunk)
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      await onLine(line)
    }
  }
  if (pending) await onLine(pending.replace(/\r$/, ''))
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
  return runOwnedProcess(options, async (child) => {
    let eventChain = Promise.resolve()
    const emit = (event: NativeEventInput) => {
      eventChain = eventChain.then(() => options.onEvent(event))
      return eventChain
    }
    let stderr = ''
    await settleReaders(child, [
      readLines(child.stdout, async (line) => { if (line.trim()) await emit(asEvent(line)) }),
      readLines(child.stderr, async (line) => {
        stderr = (stderr + `${line}\n`).slice(0, MAX_STDERR_LENGTH)
        await emit({ type: 'stderr', payload: { text: line } })
      }),
    ])
    return { stderr }
  })
}

export async function runCommand(binary: string, args: string[], cwd: string, signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  return runOwnedProcess({ binary, args, cwd, ...(signal ? { signal } : {}), ...(environment ? { environment } : {}) }, async (child) => {
    const collect = async (stream: Readable) => {
      stream.setEncoding('utf8')
      let text = ''
      for await (const chunk of stream) text += String(chunk)
      return text
    }
    const [stdout = '', stderr = ''] = await settleReaders(child, [collect(child.stdout), collect(child.stderr)])
    return { stdout, stderr }
  })
}

/** Qualification commands share cancellation and are all drained on failure. */
export async function runCommands(binary: string, commands: string[][], cwd: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runCommand>>[]> {
  const failure = new AbortController()
  const combined = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal
  const tasks = commands.map((args) => runCommand(binary, args, cwd, combined))
  try {
    return await Promise.all(tasks)
  } catch (error) {
    failure.abort(error)
    await Promise.allSettled(tasks)
    throw error
  }
}

/** Bidirectional providers use the same tree ownership as one-shot harnesses. */
export function spawnOwnedStdioProcess(options: {
  binary: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  onError(error: Error): void
}): {
  child: ChildProcessWithoutNullStreams
  closed: Promise<ProcessExit>
  close(): Promise<void>
} {
  const child = spawn(options.binary, options.args, {
    cwd: options.cwd, env: options.environment,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let didClose = false
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('close', (exitCode, exitSignal) => {
      didClose = true
      resolve({ exitCode, exitSignal })
    })
  })
  let shutdown: Promise<void> | undefined
  const within = async (operation: Promise<unknown>, milliseconds: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds) }),
      ])
    } finally { clearTimeout(timer) }
  }
  const close = (): Promise<void> => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      let failure: unknown
      const send = async (signal: NodeJS.Signals) => {
        try {
          if (!await within(signalTree(child, signal), PROCESS_SHUTDOWN_GRACE_MS)) {
            failure ??= new Error('Timed out signaling the owned provider process tree.')
          }
        } catch (error) { failure ??= error }
      }
      try {
        // Signal the group even after its leader exited: descendants may own pipes.
        await send('SIGTERM')
        if (!didClose) await within(closed, PROCESS_SHUTDOWN_GRACE_MS)
        await send('SIGKILL')
        if (!didClose && !await within(closed, PROCESS_SHUTDOWN_GRACE_MS)) {
          failure ??= new Error('Provider process did not close after forced tree shutdown.')
        }
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        ownedProcesses.delete(child)
      }
      if (failure) throw failure
    })()
    // Event-driven cleanup must never create an unhandled rejection.
    void shutdown.catch(() => undefined)
    return shutdown
  }
  ownedProcesses.set(child, close)
  const failed = (error: Error) => {
    try { options.onError(error) } catch { /* A lifecycle observer cannot crash the API. */ }
    finally { void close().catch(() => undefined) }
  }
  child.on('error', failed)
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', failed)
  child.once('exit', () => { void close().catch(() => undefined) })
  return { child, closed, close }
}
