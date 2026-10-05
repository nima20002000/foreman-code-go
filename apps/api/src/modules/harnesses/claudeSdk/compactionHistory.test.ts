import { mkdtemp, mkdir, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { readClaudeCompactionHistory, recoveredClaudeCompaction } from './compactionHistory.js'

it('recovers only the new manual boundary from the same persisted session and scope', async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'claude-boundaries-'))
  const nativeSessionId = randomUUID()
  const cwd = '/owned-project'
  const directory = join(profilePath, 'projects', '-owned-project')
  const path = join(directory, `${nativeSessionId}.jsonl`)
  const session = { nativeSessionId, profilePath, cwd, configRevision: 'configuration', deviceId: 'host' }
  const frame = (uuid: string, trigger: string) => ({ type: 'system', subtype: 'compact_boundary', uuid,
    cwd, sessionId: nativeSessionId, compactMetadata: { trigger, preTokens: 123000 }, timestamp: new Date().toISOString() })
  try {
    await mkdir(directory, { recursive: true })
    await appendFile(path, `${JSON.stringify(frame('old-boundary', 'manual'))}\n`)
    const before = await readClaudeCompactionHistory(session)
    await appendFile(path, `${JSON.stringify(frame('automatic-boundary', 'auto'))}\n${JSON.stringify(frame('new-boundary', 'manual'))}\n`)
    const after = await readClaudeCompactionHistory(session, before.cursor)
    const state = { requestId: 'compact-command', nativeSessionId, nativeOperationId: null,
      claudeCursor: before.cursor, status: 'uncertain' as const, message: '', beforeTokens: null, observedAt: new Date().toISOString() }
    expect(recoveredClaudeCompaction(state, after.boundaries)).toMatchObject({ status: 'completed', nativeOperationId: 'new-boundary', beforeTokens: 123000 })
    await expect(readClaudeCompactionHistory({ ...session, configRevision: 'other' }, before.cursor)).rejects.toThrow('identity changed')
    expect(recoveredClaudeCompaction(state, [frame('a', 'manual'), frame('b', 'manual')]).status).toBe('uncertain')
  } finally { await rm(profilePath, { recursive: true, force: true }) }
})
