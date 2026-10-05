import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { FileToolContextSchema } from '../../files/tools/context.js'
import type { FileToolContext } from '../../files/tools/types.js'
import { bootIdentity, identityAlive, processIdentity, sessionAlive } from '../recovery/linuxIdentity.js'
import { NativeProcessRegistry, type NativeProcessRecovery } from '../recovery/processRegistry.js'
import { privateDirectory, readRecord, syncDirectory, writeRecord } from '../recovery/storage.js'
import { cleanupOpenCodeDirectory, type OpenCodeDirectoryOwnership } from './cleanup.js'
import { checkFileCondition } from './types.js'

const identity = z.object({ pid: z.number().int().min(2), startTicks: z.string().regex(/^\d+$/),
  group: z.number().int(), session: z.number().int(), state: z.string() }).strict()
const recordSchema = z.object({
  schemaVersion: z.literal(1), boot: z.string().uuid(), api: identity, native: identity,
  recovery: z.object({ root: z.string(), owner: z.string(), launchId: z.string().uuid() }).strict().optional(),
  directory: z.object({ path: z.string(), dev: z.string(), ino: z.string(), parentDev: z.string(),
    parentIno: z.string(), quarantine: z.string() }).strict(),
  context: FileToolContextSchema,
}).strict()
const recoveries = new Map<string, Promise<void>>()

/** Stored in the API vault, outside every native filesystem namespace. */
export class OpenCodeFileCleanupJournal {
  private readonly root: string
  constructor(vault: string, private readonly conversationId?: string) {
    this.root = privateDirectory(join(vault, 'opencode-file-cleanup'))
  }

  register(directory: OpenCodeDirectoryOwnership, nativePid: number, context: FileToolContext,
    recovery?: NativeProcessRecovery): string {
    const api = processIdentity(process.pid)
    const native = processIdentity(nativePid)
    checkFileCondition(api && native, 'FILE_CLEANUP_REQUIRED', 'Persist the live native process and directory owner.')
    const id = randomUUID()
    const record = recordSchema.parse({ schemaVersion: 1, boot: bootIdentity(), api, native, directory, context,
      ...(recovery?.launchId ? { recovery } : {}) })
    writeRecord(join(this.root, `${id}.json`), record, true)
    return id
  }

  async forget(id: string): Promise<void> {
    checkFileCondition(z.string().uuid().safeParse(id).success, 'FILE_CLEANUP_REQUIRED', 'Invalid cleanup registration.')
    try { await unlink(join(this.root, `${id}.json`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    syncDirectory(this.root)
  }

  recover(onClosed: (context: FileToolContext) => Promise<void>, signal: AbortSignal,
    retainedTurnIds: ReadonlySet<string> = new Set()): Promise<void> {
    const previous = recoveries.get(this.root) ?? Promise.resolve()
    // The previous caller receives its failure; subsequent recovery can retry independently.
    const task = previous.catch(() => undefined).then(() => this.recoverReady(onClosed, signal, retainedTurnIds))
    recoveries.set(this.root, task)
    void task.finally(() => {
      if (recoveries.get(this.root) === task) recoveries.delete(this.root)
    }).catch(() => undefined)
    return task
  }

  private async recoverReady(onClosed: (context: FileToolContext) => Promise<void>, signal: AbortSignal,
    retainedTurnIds: ReadonlySet<string>): Promise<void> {
    const errors: unknown[] = []
    for (const name of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      signal.throwIfAborted()
      const raw = readRecord(join(this.root, name))
      if (!raw) continue
      const record = recordSchema.parse(raw)
      if (this.conversationId && record.context.scope.chat.conversationId !== this.conversationId) continue
      // A live bridge releases its own descriptors after the native generation closes.
      if (record.boot === bootIdentity() && record.api.pid === process.pid && identityAlive(record.api)
        && record.context.turnId && retainedTurnIds.has(record.context.turnId)) continue
      if (record.boot === bootIdentity() && identityAlive(record.api) && identityAlive(record.native)) continue
      try {
        if (record.recovery) {
          const registry = new NativeProcessRegistry(record.recovery.root)
          await registry.closeRegistration(record.recovery, record.recovery.launchId, signal)
        } else if (record.boot === bootIdentity()
          && (identityAlive(record.native) || sessionAlive(record.native.session))) {
          continue
        }
        // A registry closure or an empty, exited Bubblewrap session closes its PID namespace descendants.
        await onClosed(record.context)
        await cleanupOpenCodeDirectory(record.directory)
        await this.forget(name.slice(0, -5))
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Persisted OpenCode file cleanup needs retry.')
  }
}
