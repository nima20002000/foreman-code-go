import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { prepareVerificationQualificationSource } from './verificationQualificationSource.js'

const roots: string[] = []
const run = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'verification-snapshot-'))
  roots.push(root)
  const directory = join(root, 'approved')
  const namespace = join(root, 'qualification')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(namespace, { mode: 0o700 })
  await mkdir(join(directory, 'scripts'), { mode: 0o700 })
  const files = [
    { path: 'package.json', bytes: Buffer.from('{"name":"approved"}\n'), executable: false },
    { path: 'scripts/check', bytes: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true },
  ]
  for (const file of files) await writeFile(join(directory, file.path), file.bytes,
    { mode: file.executable ? 0o700 : 0o600 })
  const manifest = createSourceManifest({ version: 1,
    approvedSourceId: '00000000-0000-4000-8000-000000000001',
    snapshotId: '00000000-0000-4000-8000-000000000002', capturePolicy: 'git-tree-v1',
    executablePolicy: 'preserve-approved', deletions: [],
    git: { commit: '2'.repeat(objectFormat === 'sha1' ? 40 : 64),
      tree: '3'.repeat(objectFormat === 'sha1' ? 40 : 64), objectFormat },
    entries: files.map(file => ({ path: file.path, kind: 'file', byteSize: file.bytes.length,
      sha256: sourceSha256(file.bytes), executable: file.executable })),
  })
  return { directory, namespace, manifest, signal: new AbortController().signal }
}

describe('approved verification snapshot and private Git preparation', () => {
  it.each(['sha1', 'sha256'] as const)('builds a readable clean %s Git view from only the complete approved bytes', async format => {
    const input = await fixture(format)
    const result = await prepareVerificationQualificationSource(input)
    const options = { cwd: result.sourceRoot, env: { PATH: process.env.PATH,
      GIT_DIR: result.gitDirectory, GIT_WORK_TREE: result.sourceRoot, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } }
    const head = (await run('git', ['rev-parse', 'HEAD'], options)).stdout.trim()
    expect(head).toBe(result.privateGit.generatedCommit)
    expect(result.privateGit.sourceCommit).toBe(input.manifest.git!.commit)
    expect((await run('git', ['status', '--porcelain'], options)).stdout).toBe('')
    expect((await run('git', ['show', 'HEAD:package.json'], options)).stdout).toBe('{"name":"approved"}\n')
    expect((await run('git', ['ls-tree', 'HEAD:scripts'], options)).stdout).toMatch(/^100755 blob .*\tcheck\n$/)
    expect(await readFile(join(result.sourceRoot, 'scripts/check'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  })

  it.each(['changed', 'extra', 'symlink'] as const)('rejects a %s protected snapshot before treating it as qualification input', async fault => {
    const input = await fixture()
    if (fault === 'changed') await writeFile(join(input.directory, 'package.json'), '{}')
    if (fault === 'extra') await writeFile(join(input.directory, 'unapproved.json'), '{}')
    if (fault === 'symlink') {
      await rm(join(input.directory, 'package.json'))
      await symlink('/etc/hosts', join(input.directory, 'package.json'))
    }
    await expect(prepareVerificationQualificationSource(input)).rejects.toThrow()
  })
})
