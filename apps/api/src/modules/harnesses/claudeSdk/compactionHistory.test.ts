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
    const reconstructed = { deviceId: session.deviceId, configRevision: session.configRevision,
      profilePath, cwd, nativeSessionId }
    expect((await readClaudeCompactionHistory(reconstructed, before.cursor)).boundaries).toEqual(after.boundaries)
    const state = { requestId: 'compact-command', nativeSessionId, nativeOperationId: null,
      claudeCursor: before.cursor, status: 'uncertain' as const, message: '', beforeTokens: null, observedAt: new Date().toISOString() }
    const pending = recoveredClaudeCompaction(state, after.boundaries)
    expect(pending).toMatchObject({ status: 'uncertain', nativeOperationId: 'new-boundary', beforeTokens: 123000 })
    const nativeRequestId = randomUUID()
    await saveClaudeCompactionResult(session, nativeRequestId, 'completed')
    expect(await recoverPersistedClaudeCompaction({ ...pending, nativeRequestId,
      claudeSession: { deviceId: session.deviceId, configRevision: session.configRevision, profilePath, cwd } }))
      .toMatchObject({ status: 'completed', nativeOperationId: 'new-boundary', beforeTokens: 123000 })
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

it('recovers a completed boundary before a large unfinished native record without consuming its tail', async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'claude-partial-boundary-'))
  const nativeSessionId = randomUUID()
  const cwd = '/owned-project'
  const directory = join(profilePath, 'projects', '-owned-project')
  const path = join(directory, `${nativeSessionId}.jsonl`)
  const session = { nativeSessionId, profilePath, cwd, configRevision: 'configuration', deviceId: 'host' }
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(),
    cwd, sessionId: nativeSessionId, compactMetadata: { trigger: 'manual', preTokens: 123000 },
    timestamp: new Date().toISOString() }
  const trailingRecord = JSON.stringify({ type: 'assistant', cwd, sessionId: nativeSessionId,
    message: { content: 'x'.repeat(150000) } })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'system', sessionId: nativeSessionId, cwd })}\n`)
    const before = await readClaudeCompactionHistory(session)
    await appendFile(path, `${JSON.stringify(boundary)}\n${trailingRecord.slice(0, -2)}`)
    const recovered = await readClaudeCompactionHistory(session, before.cursor)
    expect(recovered.boundaries).toEqual([boundary])
    expect(recoveredClaudeCompaction({ requestId: randomUUID(), nativeSessionId, nativeOperationId: null,
      status: 'uncertain', message: '', beforeTokens: null, observedAt: new Date().toISOString() },
    recovered.boundaries)).toMatchObject({ status: 'uncertain', nativeOperationId: boundary.uuid })

    expect((await readClaudeCompactionHistory(session, recovered.cursor)).boundaries).toEqual([])
    await appendFile(path, `${trailingRecord.slice(-2)}\n`)
    const finished = await readClaudeCompactionHistory(session, recovered.cursor)
    expect(finished.boundaries).toEqual([])
    const nextBoundary = { ...boundary, uuid: randomUUID() }
    await appendFile(path, `${JSON.stringify(nextBoundary)}\n`)
    expect((await readClaudeCompactionHistory(session, finished.cursor)).boundaries).toEqual([nextBoundary])
  } finally {
    await rm(profilePath, { recursive: true, force: true })
  }
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
