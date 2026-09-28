import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../../../infrastructure/logger.js'
import { bootIdentity, identityAlive, processIdentity, type LinuxProcessIdentity } from './linuxIdentity.js'
import { cgroupBoundary, cgroupPopulated, killCgroup, retireCgroup, type NativeCgroupBoundary } from './cgroupBoundary.js'
import { NATIVE_GUARDIAN_SOURCE } from './nativeGuardian.js'
import { nativeAgentEnvironment } from '../secrets.js'
import { privateDirectory, readRecord, recordObject, syncDirectory, writeRecord } from './storage.js'

export interface NativeProcessRecovery {
  root: string
  owner: string
  /** Write-ahead registration captured before the workflow's entered commit. */
  launchId?: string
}
// This tracks ordinary sequential subprocesses of the SAME live manager. It is
// never consulted as closure evidence and cannot be reconstructed on restart.
const consumedLaunchScopes = new WeakSet<NativeProcessRecovery>()
interface LaunchRecord {
  format: 1; id: string; owner: string; boot: string; parent: LinuxProcessIdentity; controlKey: string
}
interface BirthRecord { format: 1; id: string; owner: string; boot: string; guardian: LinuxProcessIdentity; containment?: NativeCgroupBoundary }
const owned = new WeakMap<ChildProcess, { scope: NativeProcessRecovery; id: string; closed?: boolean }>()
const closing = new Map<string, Promise<void>>()
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
  if (row.containment !== undefined) cgroupBoundary(row.containment, launch.id)
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

type ClosureEvidence = 'linux_boot_changed' | 'native_not_started' | 'cgroup_v2_empty'

function closedRecord(directory: string, launch: LaunchRecord): boolean {
  const value = readRecord(join(directory, 'closed.json'))
  if (value === undefined) return false
  const row = recordObject(value)
  if (row.id !== launch.id || row.owner !== launch.owner) throw new Error('Native close evidence owner mismatch.')
  // Version 1 used session absence, which does not cover detached descendants.
  // Requalify legacy records below; never promote their old marker into proof.
  if (row.format === 1) return false
  if (row.format !== 2 || row.boot !== launch.boot
    || !['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty'].includes(String(row.evidence))) {
    throw new Error('Invalid native closure evidence.')
  }
  return true
}

function retiredOwner(directory: string, owner: string, id?: string): boolean {
  const value = readRecord(join(directory, 'retired.json'))
  if (value === undefined) return false
  const row = recordObject(value)
  if (row.format !== 2 || row.owner !== owner || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id)) {
    throw new Error('Invalid native retirement receipt.')
  }
  return id === undefined || row.id === id
}

function retireRegistration(directory: string, launch: LaunchRecord): void {
  if (!closedRecord(directory, launch)) throw new Error('Unconfirmed native registrations cannot be retired.')
  const rawBirth = readRecord(join(directory, 'birth.json'))
  if (launch.boot === bootIdentity()) {
    let boundary = rawBirth === undefined ? undefined : birthRecord(rawBirth, launch).containment
    const reserved = readRecord(join(directory, 'containment.json'))
    if (reserved !== undefined) {
      const row = recordObject(reserved)
      if (row.format !== 1 || row.id !== launch.id || row.owner !== launch.owner || row.boot !== launch.boot) {
        throw new Error('Native cgroup reservation owner mismatch.')
      }
      const registered = cgroupBoundary(row.boundary, launch.id)
      if (boundary && (boundary.path !== registered.path || boundary.device !== registered.device || boundary.inode !== registered.inode)) {
        throw new Error('Conflicting native cgroup certificates.')
      }
      boundary = registered
    }
    if (boundary) retireCgroup(boundary)
  }
  const ownerDirectory = dirname(directory)
  // One compact receipt preserves "known closed" versus "no evidence" after GC.
  writeRecord(join(ownerDirectory, 'retired.json'), { format: 2, owner: launch.owner, id: launch.id })
  const retired = join(ownerDirectory, `.retired-${launch.id}`)
  renameSync(directory, retired)
  syncDirectory(ownerDirectory)
  // The durable rename is the GC commit point. A crash during deletion leaves
  // only a tombstone; it can never reappear as an unresolved launch.
  rmSync(retired, { recursive: true })
  syncDirectory(ownerDirectory)
}

function confirmClosed(directory: string, launch: LaunchRecord, evidence: ClosureEvidence): void {
  writeRecord(join(directory, 'closed.json'), { format: 2, id: launch.id, owner: launch.owner, boot: launch.boot,
    observedAt: new Date().toISOString(), evidence })
  retireRegistration(directory, launch)
}

/** Compact proven closures BEFORE enforcing the unresolved-work bound. */
function inventory(directory: string, owner: string): string[] {
  const ids: string[] = []
  for (const id of readdirSync(directory)) {
    if (id === 'retired.json') { retiredOwner(directory, owner); continue }
    if (/^\.retired-[0-9a-f-]{36}$/.test(id)) {
      privateDirectory(join(directory, id))
      rmSync(join(directory, id), { recursive: true })
      syncDirectory(directory)
      continue
    }
    // storage.writeRecord may leave a private temporary receipt after a crash.
    // It is not a registration or closure proof; a live writer may still own it.
    if (/^\.pending-[0-9a-f-]{36}$/.test(id)) continue
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unexpected native process inventory entry.')
    const path = privateDirectory(join(directory, id))
    const launch = launchRecord(readRecord(join(path, 'intent.json')))
    if (launch.owner !== owner || launch.id !== id) throw new Error('Native owner inventory mismatch.')
    if (closedRecord(path, launch)) { retireRegistration(path, launch); continue }
    if (launch.boot !== bootIdentity()) { confirmClosed(path, launch, 'linux_boot_changed'); continue }
    const notStarted = readRecord(join(path, 'not-started.json'))
    if (notStarted !== undefined) {
      const row = recordObject(notStarted)
      if (row.id !== id || row.owner !== owner || readRecord(join(path, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      confirmClosed(path, launch, 'native_not_started')
      continue
    }
    ids.push(id)
    if (ids.length > 10_000) throw new Error('Native recovery inventory exceeds its unresolved-work scan limit.')
  }
  return ids
}

/** Backend-owned registry. An empty registry is NOT evidence about pre-upgrade processes. */
export class NativeProcessRegistry {
  constructor(private readonly root: string) {}
  scope(owner: string): NativeProcessRecovery {
    if (!owner.trim() || owner.length > 4096) throw new Error('Invalid process owner.')
    return { root: this.root, owner }
  }
  /** Allocate before authorizing native submission, not at child_process.spawn.
   * A dead original parent plus this durable intent and no dispatch is positive
   * native_not_started evidence. A missing directory still proves nothing. */
  reserveLaunch(owner: string): NativeProcessRecovery {
    const scope = this.scope(owner)
    if (process.platform !== 'linux') return scope
    return { ...scope, launchId: reserveProcess(scope).id }
  }
  async closeOwner(owner: string, signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'linux') return false
    const root = privateDirectory(this.root)
    const directory = join(root, key(owner))
    try { lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    privateDirectory(directory)
    const registrations = inventory(directory, owner)
    if (!registrations.length) return retiredOwner(directory, owner)
    const failures: unknown[] = []
    for (const id of registrations) {
      try { await this.closeRegistration({ root, owner }, id, signal) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Native process closure remains unconfirmed.')
    return true
  }
  closeRegistration(scope: NativeProcessRecovery, id: string, signal?: AbortSignal): Promise<void> {
    const identity = JSON.stringify([resolve(scope.root), scope.owner, id])
    const previous = closing.get(identity)
    if (previous) return previous
    const attempt = this.closeRegistered(scope, id, signal)
    closing.set(identity, attempt)
    void attempt.finally(() => { if (closing.get(identity) === attempt) closing.delete(identity) }).catch(() => undefined)
    return attempt
  }

  private async closeRegistered(scope: NativeProcessRecovery, id: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid process registration.')
    signal?.throwIfAborted()
    const directory = join(privateDirectory(scope.root), key(scope.owner), id)
    // A retry after the GC rename must use the exact durable retirement receipt,
    // never infer closure merely because this registration is missing.
    try { lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        || !retiredOwner(dirname(directory), scope.owner, id)) throw error
      const tombstone = join(dirname(directory), `.retired-${id}`)
      try { lstatSync(tombstone) } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return
        throw missing
      }
      privateDirectory(tombstone)
      rmSync(tombstone, { recursive: true })
      syncDirectory(dirname(directory))
      return
    }
    privateDirectory(directory)
    const launch = launchRecord(readRecord(join(directory, 'intent.json')))
    if (launch.owner !== scope.owner || launch.id !== id) throw new Error('Native process owner mismatch.')
    if (closedRecord(directory, launch)) { retireRegistration(directory, launch); return }
    const boot = bootIdentity()
    const neverStarted = readRecord(join(directory, 'not-started.json'))
    if (neverStarted !== undefined) {
      const record = recordObject(neverStarted)
      if (record.id !== id || record.owner !== scope.owner || readRecord(join(directory, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      confirmClosed(directory, launch, 'native_not_started'); return
    }
    // A different kernel boot proves no process from the earlier boot can execute.
    if (launch.boot !== boot) { confirmClosed(directory, launch, 'linux_boot_changed'); return }
    const end = Date.now() + 5_000
    let requested = false
    const forceAt = Date.now() + 1_000
    let forced = false
    while (Date.now() < end) {
      signal?.throwIfAborted()
      const rawBirth = readRecord(join(directory, 'birth.json'))
      if (rawBirth === undefined) {
        const dispatched = readRecord(join(directory, 'dispatched.json'))
        if (dispatched === undefined) {
          // Parent persists dispatched BEFORE sending the native configuration.
          if (!identityAlive(launch.parent)) { confirmClosed(directory, launch, 'native_not_started'); return }
        } else {
          const record = recordObject(dispatched)
          const guardian = recordObject(record.guardian)
          if (record.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
            || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
          if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })) {
            // The guardian cannot start a native executable until birth.json is durable.
            // Re-read after observing exit so a concurrent final publication cannot be missed.
            if (readRecord(join(directory, 'birth.json')) === undefined) { confirmClosed(directory, launch, 'native_not_started'); return }
          }
        }
      } else {
        const birth = birthRecord(rawBirth, launch)
        if (birth.containment && !cgroupPopulated(birth.containment)) {
          confirmClosed(directory, launch, 'cgroup_v2_empty'); return
        }
        if (birth.containment && !forced && (Date.now() >= forceAt || !identityAlive(birth.guardian))) {
          killCgroup(birth.containment)
          forced = true
        }
        // Without a kernel boundary, even a vanished session cannot prove that
        // detached descendants are gone. Keep legacy work fenced on this boot.
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
}

/** A fresh manager cannot overlap an older, still-running native process for this owner. */
function assertOwnerIdle(directory: string, owner: string): void {
  const boot = bootIdentity()
  const ids = inventory(directory, owner)
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unexpected native process inventory entry.')
    const previous = privateDirectory(join(directory, id))
    const intent = launchRecord(readRecord(join(previous, 'intent.json')))
    if (intent.owner !== owner || intent.id !== id) throw new Error('Native owner inventory mismatch.')
    if (intent.boot !== boot) { confirmClosed(previous, intent, 'linux_boot_changed'); continue }
    const notStarted = readRecord(join(previous, 'not-started.json'))
    if (notStarted !== undefined) {
      const record = recordObject(notStarted)
      if (record.id !== id || record.owner !== owner || readRecord(join(previous, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      confirmClosed(previous, intent, 'native_not_started')
      continue
    }
    const rawBirth = readRecord(join(previous, 'birth.json'))
    if (rawBirth !== undefined) {
      const boundary = birthRecord(rawBirth, intent).containment
      if (boundary && !cgroupPopulated(boundary)) { confirmClosed(previous, intent, 'cgroup_v2_empty'); continue }
    } else {
      const rawDispatch = readRecord(join(previous, 'dispatched.json'))
      if (rawDispatch === undefined) {
        if (!identityAlive(intent.parent)) { confirmClosed(previous, intent, 'native_not_started'); continue }
      } else {
        const dispatched = recordObject(rawDispatch)
        const guardian = recordObject(dispatched.guardian)
        if (dispatched.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
          || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
        if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })
          && readRecord(join(previous, 'birth.json')) === undefined) {
          confirmClosed(previous, intent, 'native_not_started'); continue
        }
      }
    }
    throw new Error('An earlier native process is still active or unconfirmed; recover it before starting another.')
  }
}

/** Publish a complete intent atomically. A crash before the rename cannot leave
 * a half-registration in the unresolved inventory. No executable is dispatched. */
function reserveProcess(scope: NativeProcessRecovery): LaunchRecord {
  const ownerDirectory = privateDirectory(join(privateDirectory(scope.root), key(scope.owner)))
  assertOwnerIdle(ownerDirectory, scope.owner)
  const parent = processIdentity(process.pid)
  if (!parent) throw new Error('Cannot identify the launching API process.')
  const id = randomUUID()
  const launch: LaunchRecord = { format: 1, id, owner: scope.owner, boot: bootIdentity(), parent,
    controlKey: randomBytes(32).toString('hex') }
  const temporary = privateDirectory(join(ownerDirectory, `.pending-${id}`))
  writeRecord(join(temporary, 'intent.json'), launch, true)
  renameSync(temporary, join(ownerDirectory, id))
  syncDirectory(ownerDirectory)
  return launch
}

/** A recovered/revoked scope must NEVER silently allocate a replacement launch.
 * The parent identity and immutable id fence the handoff. All operations through
 * guardian dispatch are synchronous; a live parent cannot race its own cleanup.
 * A foreign recovery process can prove no-dispatch only after that parent dies. */
function takeLaunch(scope: NativeProcessRecovery): LaunchRecord {
  if (!scope.launchId || consumedLaunchScopes.has(scope)) return reserveProcess(scope)
  if (!/^[0-9a-f-]{36}$/.test(scope.launchId)) throw new Error('Invalid reserved native launch.')
  const directory = join(privateDirectory(scope.root), key(scope.owner), scope.launchId)
  const launch = launchRecord(readRecord(join(directory, 'intent.json')))
  const parent = processIdentity(process.pid)
  if (launch.id !== scope.launchId || launch.owner !== scope.owner || launch.boot !== bootIdentity()
    || !parent || launch.parent.pid !== parent.pid || launch.parent.startTicks !== parent.startTicks
    || readRecord(join(directory, 'claimed.json')) !== undefined
    || readRecord(join(directory, 'dispatched.json')) !== undefined
    || readRecord(join(directory, 'birth.json')) !== undefined
    || readRecord(join(directory, 'not-started.json')) !== undefined
    || readRecord(join(directory, 'closed.json')) !== undefined) {
    throw new Error('The exact native launch reservation is no longer dispatchable.')
  }
  // Exclusive, durable single-use claim; it does not authorize native code.
  // dispatched.json still precedes sending configuration to the guardian.
  writeRecord(join(directory, 'claimed.json'), { format: 1, id: launch.id, owner: scope.owner }, true)
  return launch
}

/**
 * A Node guardian leads the process session and writes a birth certificate BEFORE
 * spawning native code. Its authenticated control socket survives API replacement.
 * Native stdin/stdout/stderr retain their original pipe semantics.
 */
export function spawnNativeProcess(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; recovery?: NativeProcessRecovery
}): ChildProcessWithoutNullStreams {
  return observeNativeProcess(spawnNativeProcessUnobserved(binary, args, {
    ...options, env: nativeAgentEnvironment(binary, options.cwd, options.env),
  }), binary, options.recovery?.owner)
}

const harnessLog = componentLogger('harness')
/** Every native harness start and end is logged: binary name, pid, exit code or signal.
 * Arguments and environment are never logged; they can carry prompts and credentials. */
function observeNativeProcess(child: ChildProcessWithoutNullStreams, binary: string, owner: string | undefined) {
  const facts = { binary: basename(binary), ...(owner ? { owner } : {}) }
  child.once('spawn', () => harnessLog.info({ ...facts, childPid: child.pid }, 'harness process started'))
  // No 'error' listener here: adding one would change whether an unhandled spawn error crashes the caller.
  child.once('exit', (exitCode, signal) => harnessLog[exitCode === 0 ? 'info' : 'warn']({ ...facts, childPid: child.pid, exitCode, signal },
    'harness process exited'))
  return child
}

function spawnNativeProcessUnobserved(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; recovery?: NativeProcessRecovery
}): ChildProcessWithoutNullStreams {
  if (!options.recovery || process.platform !== 'linux') return spawn(binary, args, {
    cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const scope = options.recovery
  const launch = takeLaunch(scope)
  const { id } = launch
  const directory = join(privateDirectory(scope.root), key(scope.owner), id)
  const child = spawn(process.execPath, ['-e', NATIVE_GUARDIAN_SOURCE], {
    cwd: directory, env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  // Observe startup errors before sending configuration or exposing the child to the adapter.
  child.on('error', () => undefined)
  owned.set(child, { scope, id })
  if (scope.launchId) consumedLaunchScopes.add(scope)
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
  if (registration.closed) return true
  await new NativeProcessRegistry(registration.scope.root).closeRegistration(registration.scope, registration.id)
  registration.closed = true
  return true
}
