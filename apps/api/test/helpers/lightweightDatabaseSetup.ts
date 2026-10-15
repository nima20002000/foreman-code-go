import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import type { TestProject } from 'vitest/node'

export default async function setup(project: TestProject) {
  // Keep WebAssembly compilation from fanning out across the machine's CPUs.
  setFlagsFromString('--wasm-num-compilation-tasks=1')
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'light-pg-'))
  const database = await PGlite.create(join(directory, 'data'))
  const server = new PGLiteSocketServer({
    db: database,
    path: join(directory, '.s.PGSQL.5432'),
    maxConnections: 1,
  })
  try {
    await server.start()
    project.provide('lightDatabaseDirectory', directory)
  } catch (error) {
    await database.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return async () => {
    try {
      await server.stop()
    } finally {
      await database.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
