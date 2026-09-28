import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { localCodexChatHost } from '../src/modules/harnesses/codexFiles/localHost.js'

test('Codex chat host delivers verified read-only bytes and rejects mutable paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-host-test-'))
  try {
    const host = await localCodexChatHost(root)
    const bytes = Buffer.from('# attachment\n')
    const input = { filename: 'notes.md', mediaType: 'text/markdown' as const,
      byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), writable: false,
      bytes: Readable.from([bytes]) }
    const copy = await host.materialize(input)
    assert.equal(copy.writable, false)
    assert.deepEqual(await readFile(copy.executionPath), bytes)
    assert.equal((await stat(copy.executionPath)).mode & 0o222, 0)
    await assert.rejects(host.materialize({ ...input, writable: true, bytes: Readable.from([bytes]) }),
      /CODEX_MUTABLE_HOST_PATH_DENIED/)
    await assert.rejects(host.sealCompleted(copy.registrationId), /CODEX_MUTABLE_HOST_PATH_DENIED/)
    await host.close()
    await host.close()
    await assert.rejects(stat(copy.executionPath), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
