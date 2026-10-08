import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { systemDrivePorts } from './driveComputer.js'

it('writes simultaneous private files atomically without sharing a temporary name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drive-config-'))
  try {
    const path = join(directory, 'rclone.conf')
    const ports = systemDrivePorts()
    const contents = Array.from({ length: 12 }, (_, index) => `token-${index}\n`.repeat(1000))
    await Promise.all(contents.map(content => ports.writePrivate(path, content)))
    expect(contents).toContain(await readFile(path, 'utf8'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['rclone.conf'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
