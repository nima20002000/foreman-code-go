import { expect, it, vi } from 'vitest'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { workerClaudeReplacementFixture } from './workerClaudeReplacement.test-support.js'

it('keeps history, message, cancel and close usable after a remote preferences replacement', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    f.holdResume()
    const applying = f.manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ autoCompact: 'off' }))
    await vi.waitFor(() => expect(f.hasResumeWaiter()).toBe(true))
    let readFinished = false
    const reading = f.manager.history(session).then(value => { readFinished = true; return value })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(readFinished).toBe(false)
    f.releaseResume()
    await applying
    await reading
    const changed = (await f.journal.conversations.read(f.binding))!
    expect(changed.nativeOwner).not.toEqual(previous)
    expect(changed.ownerTransitions).toEqual([{ previous, next: changed.nativeOwner }])
    expect(changed.session).toEqual(session)
    expect(await f.send('after-preferences')).toEqual(session)
    expect(await f.manager.cancel(session)).toBe(false)
    await f.manager.close(session)
    expect((await f.journal.conversations.read(f.binding))?.closed).toBe(true)
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
  } finally { await f.close() }
})

it('resumes the remote session after 256 native inputs including compaction', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    await f.manager.compactSession(session, { requestId: 'manual-compact', clientCorrelationId: 'compact-input',
      onProgress: async () => {} })
    for (let index = 1; index < 255; index++) await f.send(`input-${index}`)
    expect(f.offers).toHaveLength(256)
    expect(f.resumes).toHaveLength(1)
    expect(await f.send('rollover')).toEqual(session)
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
    expect(f.offers).toHaveLength(257)
    expect(new Set(f.offers.map(message => message.uuid)).size).toBe(257)
    expect((await f.journal.conversations.read(f.binding))?.ownerTransitions).toHaveLength(1)
    await expect(f.manager.history(session)).resolves.toMatchObject({ pendingInteractions: [] })
  } finally { await f.close() }
}, 180_000)

it('settles definite remote non-delivery on Main and admits another message on the same session', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    f.failMode()
    await expect(f.send('not-offered')).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect(f.offers).toHaveLength(1)
    expect((await f.manager.reconcile(session, 'not-offered')).nonSubmission).toMatchObject({
      nativeSessionId: session.nativeSessionId, clientCorrelationId: 'not-offered', result: { outcome: 'failed' },
    })
    await expect(f.send('not-offered')).rejects.toMatchObject({ certainty: 'definite' })
    expect(await f.send('later')).toEqual(session)
    expect(f.offers).toHaveLength(2)
  } finally { await f.close() }
})

it('reports initial SDK startup non-delivery and allows a new initial request', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    f.failStartup()
    await expect(f.send('failed-initial')).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect((await f.journal.conversations.read(f.binding))?.creation?.status).toBe('rejected')
    expect(f.offers).toHaveLength(0)
    await expect(f.send('failed-initial')).rejects.toMatchObject({ certainty: 'definite' })
    await f.send('recovered-initial')
    expect(f.offers).toHaveLength(1)
    expect(f.resumes).toEqual([undefined])
  } finally { await f.close() }
})

it('rejects an ownership replacement without confirmed old-process closure', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    f.unconfirmedClosure()
    await expect(f.manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ autoCompact: 'off' })))
      .rejects.toThrow('unavailable or changed')
    expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(previous)
    expect(f.offers).toHaveLength(1)
  } finally { await f.close() }
})

it('updates ownership before delivering a message with changed next-turn preferences', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    const submitted = vi.fn(async () => {
      expect((await f.journal.conversations.read(f.binding))!.nativeOwner).not.toEqual(previous)
    })
    const stream = f.manager.startTurn(session, { prompt: 'Changed preferences', clientCorrelationId: 'next-preferences',
      sessionPreferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }), onMessageSubmitted: submitted })
    for await (const event of stream) void event
    expect(submitted).toHaveBeenCalledOnce()
    expect((await f.manager.reconcile(session, 'next-preferences')).terminalResult?.outcome).toBe('succeeded')
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
    expect(f.offers).toHaveLength(2)
  } finally { await f.close() }
})
