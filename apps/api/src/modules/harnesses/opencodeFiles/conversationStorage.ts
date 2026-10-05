import { constants } from 'node:fs'
import { copyFile, lstat, open, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { digest } from '../opencodeProtocol.js'
import { privateDirectory } from '../recovery/storage.js'
import { checkFileCondition } from './types.js'

export class OpenCodeConversationStorage {
  readonly owned: string
  readonly database: string
  private legacyDatabase: string | undefined

  constructor(readonly root: string, conversationId: string) {
    this.owned = join(root, digest(['opencode-conversation', conversationId]))
    this.database = join(this.owned, 'data', 'opencode', 'opencode.db')
  }

  async prepare(environment: NodeJS.ProcessEnv): Promise<string[]> {
    privateDirectory(this.owned)
    const originalData = join(environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode')
    const originalCache = join(environment.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'opencode')
    const originalState = join(environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode')
    this.legacyDatabase = join(originalData, 'opencode.db')
    if (environment.OPENCODE_DB) {
      this.legacyDatabase = isAbsolute(environment.OPENCODE_DB)
        ? environment.OPENCODE_DB : join(originalData, environment.OPENCODE_DB)
    }
    const hidden = [originalData, originalCache, originalState, join(tmpdir(), 'opencode')]
    if (environment.OPENCODE_DB && isAbsolute(environment.OPENCODE_DB)) {
      hidden.push(this.legacyDatabase, `${this.legacyDatabase}-wal`, `${this.legacyDatabase}-shm`)
    }
    for (const name of ['DATA', 'CACHE', 'STATE']) {
      const directory = privateDirectory(join(this.owned, name.toLowerCase()))
      environment[`XDG_${name}_HOME`] = directory
    }
    environment.TMPDIR = privateDirectory(join(this.owned, 'tmp'))
    environment.OPENCODE_DB = this.database
    privateDirectory(dirname(this.database))
    const database = await open(this.database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = await database.stat()
      checkFileCondition(stat.isFile() && stat.nlink === 1, 'FILE_SOURCE_ISOLATION_REQUIRED',
        'Native storage requires a regular conversation database.')
    } finally {
      await database.close()
    }
    try {
      await copyFile(join(originalData, 'auth.json'), join(dirname(environment.OPENCODE_DB), 'auth.json'),
        constants.COPYFILE_EXCL)
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    const existing = new Map<string, boolean>()
    for (const path of hidden) {
      try {
        const stat = await lstat(path)
        checkFileCondition(!stat.isSymbolicLink(), 'FILE_SOURCE_ISOLATION_REQUIRED',
          'Native storage paths must be canonical.')
        existing.set(path, stat.isDirectory())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return [...existing.keys()].filter(path => ![...existing].some(([parent, directory]) =>
      directory && parent !== path && path.startsWith(`${parent}/`)))
  }

  /** Copy only the admitted session tree; the native namespace never sees another owner's database. */
  async importSession(sessionId: string, directory: string, signal: AbortSignal): Promise<void> {
    const destination = new DatabaseSync(this.database)
    try {
      destination.exec('PRAGMA busy_timeout=5000')
      if (destination.prepare('select id from session where id=?').get(sessionId)) return
      const candidates = [this.legacyDatabase]
      for (const owner of await readdir(this.root)) {
        if (/^[0-9a-f]{64}$/.test(owner) && join(this.root, owner) !== this.owned) {
          candidates.push(join(this.root, owner, 'data', 'opencode', 'opencode.db'))
        }
      }
      for (const sourcePath of candidates) {
        signal.throwIfAborted()
        if (!sourcePath) continue
        try {
          const stat = await lstat(sourcePath)
          checkFileCondition(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
            'FILE_SOURCE_ISOLATION_REQUIRED', 'Import native history from a regular owned database.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const source = new DatabaseSync(sourcePath, { readOnly: true })
        try {
          if (!source.prepare('select id from session where id=? and directory=?').get(sessionId, directory)) continue
        } finally {
          source.close()
        }
        destination.prepare('attach database ? as original').run(sourcePath)
        try {
          destination.exec('begin immediate')
          const tree = `with recursive owned(id) as (
            select id from original.session where id=? and directory=?
            union all select s.id from original.session s join owned o on s.parent_id=o.id
          ) select id from owned`
          destination.prepare(`insert or ignore into project select p.* from original.project p
            where p.id in (select project_id from original.session where id in (${tree}))`).run(sessionId, directory)
          destination.prepare(`insert or ignore into session select * from original.session
            where id in (${tree})`).run(sessionId, directory)
          for (const table of ['message', 'part', 'todo', 'session_message', 'session_input', 'session_context_epoch']) {
            destination.prepare(`insert or ignore into ${table} select * from original.${table}
              where session_id in (${tree})`).run(sessionId, directory)
          }
          destination.exec('commit')
          return
        } catch (error) {
          destination.exec('rollback')
          throw error
        } finally {
          destination.exec('detach database original')
        }
      }
    } finally {
      destination.close()
    }
  }
}
