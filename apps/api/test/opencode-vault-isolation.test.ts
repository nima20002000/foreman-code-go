import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { LocalOpenCodeExecutionFiles, assertProtectedSourcePaths } from '../src/modules/harnesses/opencodeFiles/host.js'
import { OpenCodeVaultIsolation } from '../src/modules/harnesses/opencodeFiles/isolation.js'
import { sha256 } from '../src/modules/harnesses/opencodeFiles/attachments.js'

async function execute(isolation: OpenCodeVaultIsolation, directory: string, source: string, args: string[]) {
  const command = await isolation.launch({ binary: process.execPath, args: ['-e', source, ...args],
    workingDirectory: directory, environment: process.env }, AbortSignal.timeout(10_000))
  const child = spawn(command.binary, command.args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(exit, 0, stderr)
  return stdout
}

it('hides an API-owned vault and its open descriptors while sharing registered working copies', async () => {
  const directory = await mkdtemp(join(homedir(), '.opencode-vault-'))
  const vault = join(directory, 'vault')
  const copies = join(directory, 'copies')
  const original = Buffer.from('# immutable\n')
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  const handle = randomUUID()
  const host = new LocalOpenCodeExecutionFiles({ root: copies, executionHostId: 'local-test',
    maxFileBytes: MAX_FILE_BYTES,
    assertSourceIsolation: async () => { throw new Error('This test verifies the kernel boundary in the child.') } })
  try {
    await new FileByteStorage(vault, MAX_FILE_BYTES, [copies]).initialize()
    await mkdir(copies, { mode: 0o700 })
    const protectedFile = join(vault, 'objects', 'source.md')
    await writeFile(protectedFile, original, { mode: 0o600 })
    descriptor = await open(protectedFile, 'r')
    // The previous same-identity composition must still fail its ownership check.
    await assert.rejects(assertProtectedSourcePaths(process.pid, [vault], AbortSignal.timeout(10_000)))
    const registered = await host.materialize({ handle, bytes: original, writable: true,
      revision: { fileId: randomUUID(), revisionId: randomUUID(), filename: 'copy.md', mediaType: 'text/markdown',
        byteSize: original.length, sha256: sha256(original), origin: 'upload', createdAt: new Date().toISOString() },
    }, AbortSignal.timeout(10_000))
    const script = `
      const fs = require('node:fs')
      const assert = require('node:assert/strict')
      const [vault, source, copy, apiPid, apiFd, parent] = process.argv.slice(1)
      assert.deepEqual(fs.readdirSync(vault), [])
      assert.throws(() => fs.readFileSync(source), { code: 'ENOENT' })
      assert.throws(() => fs.writeFileSync(vault + '/new.md', 'tampered'), { code: 'EROFS' })
      assert.throws(() => fs.chmodSync(vault, 0o777), { code: 'EROFS' })
      assert.throws(() => fs.renameSync(parent, parent + '.moved'), { code: 'EBUSY' })
      assert.throws(() => fs.readFileSync('/proc/' + apiPid + '/fd/' + apiFd))
      assert.equal(fs.readFileSync(copy, 'utf8'), '# immutable\\n')
      fs.writeFileSync(copy, '# edited\\n')
      console.log('isolated working copy edited')
    `
    const stdout = await execute(new OpenCodeVaultIsolation(vault), directory, script,
      [vault, protectedFile, registered.path, String(process.pid), String(descriptor.fd), directory])
    assert.match(stdout, /isolated working copy edited/)
    assert.equal(Buffer.from(await host.snapshot(handle, AbortSignal.timeout(10_000))).toString(), '# edited\n')
    assert.deepEqual(await readFile(protectedFile), original)
  } finally {
    await descriptor?.close()
    await host.remove(handle)
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects a vault reached through a symlink before creating the native namespace', async () => {
  const directory = await mkdtemp(join(homedir(), '.opencode-vault-link-'))
  try {
    const vault = join(directory, 'vault')
    await new FileByteStorage(vault, MAX_FILE_BYTES).initialize()
    const alias = join(directory, 'alias')
    await symlink(vault, alias)
    await assert.rejects(new OpenCodeVaultIsolation(alias).launch({ binary: process.execPath,
      args: ['--version'], workingDirectory: directory, environment: process.env }, AbortSignal.timeout(10_000)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
