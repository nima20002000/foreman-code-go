import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { pnpmInstall } from './warmSetup.js'

it('installs warm dependencies while the shared online refill lock is unavailable', async () => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'warm-install-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'corepack'), '#!/bin/sh\necho "$*" >> calls\n', { mode: 0o700 })
    // The offline store is warm; another checkout owns the exclusive refill lock.
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const script = ['finish() { exit "$1"; }', ...pnpmInstall(join(root, 'cache'), join(root, 'message'))].join('\n')
    await promisify(execFile)('/bin/bash', ['-c', script], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    expect((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
