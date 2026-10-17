import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { RootFilesystemIdentitySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { ScenarioContext } from '../../scenario.js'

const runFile = promisify(execFile)

/** Observe OS metadata for owned fixture directories without reading application records or database internals. */
export async function ownedFilesystem(ctx: ScenarioContext, directory: string) {
  const suffix = relative(ctx.target.directory, directory)
  assert.ok(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix),
    'Filesystem expectations must stay within the fresh target directory')
  assert.equal(await realpath(directory), directory, 'Fixture directories must be canonical')
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat({ bigint: true })
    const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')
    const mountId = /^mnt_id:\s*(\d+)$/m.exec(fdInfo)?.[1]
    assert.ok(mountId, 'The Linux fixture must expose its directory mount identity')
    const filesystem = RootFilesystemIdentitySchema.parse({
      device: stat.dev.toString(), inode: stat.ino.toString(), mountId,
    })
    const { stdout } = await runFile('/usr/bin/stat', ['--file-system', '--format=%i', directory], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024, signal: ctx.signal,
      cwd: ctx.scenarioDirectory,
      env: { ...ctx.target.environment, LANG: 'C', LC_ALL: 'C' },
    })
    const filesystemId = stdout.trim()
    assert.match(filesystemId, /^[a-f0-9]{1,16}$/)
    assert.ok(!/^0+$/.test(filesystemId), 'The fixture requires a persistent filesystem identity')
    return { filesystem, filesystemId }
  } finally {
    await handle.close()
  }
}
