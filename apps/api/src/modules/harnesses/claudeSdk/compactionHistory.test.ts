import { saveClaudeCompactionResult, claudeCompactionResultMatches } from './compactionResults.js'
import { recoverPersistedClaudeCompaction } from './recoverCompaction.js'
import { mkdtemp, mkdir, appendFile, rm, writeFile } from 'node:fs/promises'
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
    const unchanged = await readClaudeCompactionHistory(session, after.cursor)
    expect(unchanged.boundaries).toEqual([])
    expect(unchanged.cursor).toEqual(after.cursor)
    await appendFile(path, '{"incomplete":\n')
    await expect(readClaudeCompactionHistory(session, after.cursor)).rejects.toBeInstanceOf(SyntaxError)
    await writeFile(path, `${JSON.stringify(frame('repaired-boundary', 'manual'))}\n`)
    expect((await readClaudeCompactionHistory(session)).boundaries).toMatchObject([{ uuid: 'repaired-boundary' }])
  } finally { await rm(profilePath, { recursive: true, force: true }) }
})

for (const outcome of ['no-op', 'failed'] as const) it(`reads a cold ${outcome} receipt without SDK startup`, async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'claude-control-recovery-'))
  const scope = { profilePath, cwd: '/owned-project', configRevision: 'configuration', deviceId: 'main' }
  const nativeSessionId = randomUUID()
  const nativeRequestId = randomUUID()
  try {
    await saveClaudeCompactionResult({ ...scope, nativeSessionId }, nativeRequestId, outcome)
    const pending = { requestId: randomUUID(), nativeSessionId, nativeRequestId, nativeOperationId: null,
      claudeSession: scope, status: 'uncertain' as const, message: '', beforeTokens: null,
      observedAt: new Date().toISOString() }
    expect((await recoverPersistedClaudeCompaction(pending)).status).toBe(outcome)
    expect((await recoverPersistedClaudeCompaction({ ...pending,
      claudeSession: { ...scope, configRevision: 'another-configuration' } })).status).toBe('uncertain')
  } finally { await rm(profilePath, { recursive: true, force: true }) }
})

it('does not settle a command from another result, a child or a malformed frame', () => {
  const result = { type: 'result', session_id: 'session', is_error: false, user_message_uuid: 'compact-uuid' }
  expect(claudeCompactionResultMatches(result, 'session', 'compact-uuid')).toBe(true)
  expect(claudeCompactionResultMatches({ ...result, user_message_uuid: 'old-turn' }, 'session', 'compact-uuid')).toBe(false)
  expect(claudeCompactionResultMatches({ ...result, parent_tool_use_id: 'child' }, 'session', 'compact-uuid')).toBe(false)
  expect(claudeCompactionResultMatches({ ...result, session_id: 'foreign' }, 'session', 'compact-uuid')).toBe(false)
  expect(claudeCompactionResultMatches({ ...result, is_error: undefined }, 'session', 'compact-uuid')).toBe(false)
})
