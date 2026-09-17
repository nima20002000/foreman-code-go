import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { bootIdentity, identityAlive, processIdentity, sessionAlive, type LinuxProcessIdentity } from './linuxIdentity.js'
import { NATIVE_GUARDIAN_SOURCE } from './nativeGuardian.js'
import { privateDirectory, readRecord, recordObject, syncDirectory, writeRecord } from './storage.js'

export interface NativeProcessRecovery { root: string; owner: string }
interface LaunchRecord {
  format: 1; id: string; owner: string; boot: string; parent: LinuxProcessIdentity; controlKey: string
}
interface BirthRecord { format: 1; id: string; owner: string; boot: string; guardian: LinuxProcessIdentity }
const owned = new WeakMap<ChildProcess, { scope: NativeProcessRecovery; id: string }>()
const key = (owner: string) => createHash('sha256').update(owner).digest('hex')
const socketName = (id: string) => `\0graphql-native-${id}`

function launchRecord(value: unknown): LaunchRecord {
  const row = recordObject(value)
  const parent = recordObject(row.parent)
  if (row.format !== 1 || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id)
    || typeof row.owner !== 'string' || typeof row.boot !== 'string'
    || typeof row.controlKey !== 'string' || !/^[0-9a-f]{64}$/.test(row.controlKey)
    || !Number.isSafeInteger(parent.pid) || Number(parent.pid) <= 1
    || typeof parent.startTicks !== 'string' || !/^\d+$/.test(parent.startTicks)) {
    throw new Error('Invalid native launch record.')
  }
  return row as unknown as LaunchRecord
}
function birthRecord(value: unknown, launch: LaunchRecord): BirthRecord {
  const row = recordObject(value)
  const guardian = recordObject(row.guardian)
  if (row.format !== 1 || row.id !== launch.id || row.owner !== launch.owner || row.boot !== launch.boot
    || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
    || guardian.group !== guardian.pid || guardian.session !== guardian.pid
    || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) {
    throw new Error('Invalid native birth certificate.')
  }
  return row as unknown as BirthRecord
}

async function stopGuardian(launch: LaunchRecord, birth: BirthRecord, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ path: socketName(launch.id) })
    let finished = false
    let buffer = ''
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(new Error('Native recovery was canceled.', { cause: signal?.reason }))
    const timer = setTimeout(() => finish(new Error('Native guardian control timed out.')), 2_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    socket.on('error', finish)
    socket.once('connect', () => socket.write(JSON.stringify({
      id: launch.id, owner: launch.owner, controlKey: launch.controlKey,
      startTicks: birth.guardian.startTicks, operation: 'stop',
    }) + '\n'))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 4096) { finish(new Error('Invalid guardian control reply.')); return }
      if (!buffer.includes('\n')) return
      try {
        const reply = recordObject(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
        if (reply.id !== launch.id || reply.startTicks !== birth.guardian.startTicks || reply.accepted !== true) {
          throw new Error('The guardian did not acknowledge this exact process generation.')
        }
        finish()
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid guardian control reply.')) }
    })
    socket.once('end', () => { if (!finished) finish(new Error('Guardian disconnected before acknowledgement.')) })
  })
}

/** Backend-owned registry. An empty registry is NOT evidence about pre-upgrade processes. */
export class NativeProcessRegistry {
  constructor(private readonly root: string) {}
  scope(owner: string): NativeProcessRecovery {
    if (!owner.trim() || owner.length > 4096) throw new Error('Invalid process owner.')
    return { root: this.root, owner }
  }
  async closeOwner(owner: string, signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'linux') return false
    const root = privateDirectory(this.root)
    const directory = join(root, key(owner))
    let ids: string[]
    try { ids = readdirSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    privateDirectory(directory)
    if (ids.length > 10_000) throw new Error('Native recovery inventory exceeds its bounded scan limit.')
    if (ids.some((id) => !/^[0-9a-f-]{36}$/.test(id))) throw new Error('Unexpected native process inventory entry; closure cannot be confirmed.')
    const registrations = ids
    if (!registrations.length) return false
    const failures: unknown[] = []
    for (const id of registrations) {
      try { await this.closeRegistration({ root, owner }, id, signal) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Native process closure remains unconfirmed.')
    return true
  }
  async closeRegistration(scope: NativeProcessRecovery, id: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid process registration.')
    signal?.throwIfAborted()
    const directory = privateDirectory(join(privateDirectory(scope.root), key(scope.owner), id))
    const launch = launchRecord(readRecord(join(directory, 'intent.json')))
    if (launch.owner !== scope.owner || launch.id !== id) throw new Error('Native process owner mismatch.')
    const boot = bootIdentity()
    const neverStarted = readRecord(join(directory, 'not-started.json'))
    if (neverStarted !== undefined) {
      const record = recordObject(neverStarted)
      if (record.id !== id || record.owner !== scope.owner || readRecord(join(directory, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      this.confirmClosed(directory, launch); return
    }
    // A different kernel boot proves no process from the earlier boot can execute.
    if (launch.boot !== boot) { this.confirmClosed(directory, launch); return }
    const end = Date.now() + 5_000
    let requested = false
    while (Date.now() < end) {
      signal?.throwIfAborted()
      const rawBirth = readRecord(join(directory, 'birth.json'))
      if (rawBirth === undefined) {
        const dispatched = readRecord(join(directory, 'dispatched.json'))
        if (dispatched === undefined) {
          // Parent persists dispatched BEFORE sending the native configuration.
          if (!identityAlive(launch.parent)) { this.confirmClosed(directory, launch); return }
        } else {
          const record = recordObject(dispatched)
          const guardian = recordObject(record.guardian)
          if (record.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
            || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
          if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })) {
            // The guardian cannot start a native executable until birth.json is durable.
            // Re-read after observing exit so a concurrent final publication cannot be missed.
            if (readRecord(join(directory, 'birth.json')) === undefined) { this.confirmClosed(directory, launch); return }
          }
        }
      } else {
        const birth = birthRecord(rawBirth, launch)
        if (!sessionAlive(birth.guardian.pid)) { this.confirmClosed(directory, launch); return }
        if (!requested && identityAlive(birth.guardian)) {
          try { await stopGuardian(launch, birth, signal); requested = true } catch (error) {
            if (signal?.aborted) throw error
            // Guardian can exit between lookup and connect. Observe again; never signal a stored PID.
          }
        }
      }
      await delay(25, undefined, signal ? { signal } : {})
    }
    throw new Error('Native closure is unconfirmed. No PID-only termination or replacement process was attempted.')
  }
  private confirmClosed(directory: string, launch: LaunchRecord) {
    writeRecord(join(directory, 'closed.json'), { format: 1, id: launch.id, owner: launch.owner,
      observedAt: new Date().toISOString(), evidence: 'linux_boot_or_session_absence' })
  }
}

/** A fresh manager cannot overlap an older, still-running native process for this owner. */
function assertOwnerIdle(directory: string, owner: string): void {
  const boot = bootIdentity()
  const ids = readdirSync(directory)
  if (ids.length > 10_000) throw new Error('Native process inventory exceeds its bounded scan limit.')
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unexpected native process inventory entry.')
    const previous = privateDirectory(join(directory, id))
    const intent = launchRecord(readRecord(join(previous, 'intent.json')))
    if (intent.owner !== owner || intent.id !== id) throw new Error('Native owner inventory mismatch.')
    if (intent.boot !== boot) continue
    const notStarted = readRecord(join(previous, 'not-started.json'))
    if (notStarted !== undefined) {
      const record = recordObject(notStarted)
      if (record.id !== id || record.owner !== owner || readRecord(join(previous, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      continue
    }
    const rawBirth = readRecord(join(previous, 'birth.json'))
    if (rawBirth !== undefined) {
      if (!sessionAlive(birthRecord(rawBirth, intent).guardian.pid)) continue
    } else {
      const rawDispatch = readRecord(join(previous, 'dispatched.json'))
      if (rawDispatch === undefined) { if (!identityAlive(intent.parent)) continue }
      else {
        const dispatched = recordObject(rawDispatch)
        const guardian = recordObject(dispatched.guardian)
        if (dispatched.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
          || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
        if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })
          && readRecord(join(previous, 'birth.json')) === undefined) continue
      }
    }
    throw new Error('An earlier native process is still active or unconfirmed; recover it before starting another.')
  }
}

/**
 * A Node guardian leads the process session and writes a birth certificate BEFORE
 * spawning native code. Its authenticated control socket survives API replacement.
 * Native stdin/stdout/stderr retain their original pipe semantics.
 */
export function spawnNativeProcess(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; recovery?: NativeProcessRecovery
}): ChildProcessWithoutNullStreams {
  if (!options.recovery || process.platform !== 'linux') return spawn(binary, args, {
    cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const scope = options.recovery
  const ownerDirectory = privateDirectory(join(privateDirectory(scope.root), key(scope.owner)))
  assertOwnerIdle(ownerDirectory, scope.owner)
  const id = randomUUID()
  const directory = privateDirectory(join(ownerDirectory, id))
  syncDirectory(ownerDirectory)
  const parent = processIdentity(process.pid)
  if (!parent) throw new Error('Cannot identify the launching API process.')
  const launch: LaunchRecord = { format: 1, id, owner: scope.owner, boot: bootIdentity(), parent,
    controlKey: randomBytes(32).toString('hex') }
  writeRecord(join(directory, 'intent.json'), launch, true)
  const child = spawn(process.execPath, ['-e', NATIVE_GUARDIAN_SOURCE], {
    cwd: directory, env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  // Observe startup errors before sending configuration or exposing the child to the adapter.
  child.on('error', () => undefined)
  owned.set(child, { scope, id })
  let dispatchAttempted = false
  try {
    if (!child.pid) {
      writeRecord(join(directory, 'not-started.json'), { id, owner: scope.owner }, true)
      return child // Node emits the ordinary spawn error; no native configuration was sent.
    }
    const guardian = processIdentity(child.pid)
    if (!guardian) throw new Error('Native guardian exited before registration.')
    writeRecord(join(directory, 'dispatched.json'), { format: 1, id, guardian }, true)
    dispatchAttempted = true
    child.send({ operation: 'start', directory, binary, args, cwd: options.cwd, environment: options.env }, (error) => {
      if (error) { try { child.disconnect() } catch { /* Already disconnected. */ } }
    })
  } catch (error) {
    // Until configuration dispatch the guardian has no native child. Closing IPC asks it to exit.
    try {
      if (!dispatchAttempted) writeRecord(join(directory, 'not-started.json'), { id, owner: scope.owner }, true)
    } finally { if (child.connected) child.disconnect() }
    throw error
  }
  return child
}

/** Registered children MUST NOT fall through to legacy PID/group signaling. */
export async function stopRecoveredChild(child: ChildProcess): Promise<boolean> {
  const registration = owned.get(child)
  if (!registration) return false
  await new NativeProcessRegistry(registration.scope.root).closeRegistration(registration.scope, registration.id)
  return true
}
