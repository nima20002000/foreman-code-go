import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const directories = []

async function nativeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-claude-native-'))
  directories.push(directory)
  const fixture = join(directory, 'sdk')
  const profile = join(directory, 'profile')
  const cwd = join(directory, 'work')
  await cp(new URL('../../fixtures/harnesses/claude-sdk/', import.meta.url), fixture, { recursive: true, errorOnExist: true })
  await mkdir(profile, { mode: 0o700 })
  await mkdir(cwd, { mode: 0o700 })
  await writeFile(join(fixture, 'fixture-scope.json'), JSON.stringify({ directory }), { mode: 0o600, flag: 'wx' })
  const sdk = await import(pathToFileURL(join(fixture, 'sdk.mjs')).href)
  const native = await import(pathToFileURL(join(fixture, 'native-tools.mjs')).href)
  const tools = await import(pathToFileURL(join(fixture, 'tools.mjs')).href)
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  return { directory, fixture, sdk, native, tools, options: { cwd, env: { CLAUDE_CONFIG_DIR: profile },
    model: 'fixture-model', permissionMode: 'default', tools: ['Write'], sandbox: { enabled: false },
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) } }
}

async function runTurns(fixture, texts, options = {}) {
  const messages = texts.map(text => ({ type: 'user', uuid: randomUUID(),
    parent_tool_use_id: null, message: { role: 'user', content: text } }))
  const prompt = { async *[Symbol.asyncIterator]() { yield* messages } }
  const query = fixture.sdk.query({ prompt, options: { ...fixture.options, ...options } })
  try {
    const initialization = await query.initializationResult()
    const frames = []
    for await (const frame of query) frames.push(frame)
    return { frames, messages, initialization, results: frames.filter(frame => frame.type === 'result') }
  } finally { query.close() }
}

describe('scripted Claude native diagnostics', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('preserves exact multi-turn, queued reply, history, resume and fork identity', async () => {
    const fixture = await nativeFixture()
    const marker = `CLAUDE_PROFILE_${randomUUID()}`
    const initial = await runTurns(fixture, [
      `Remember this exact diagnostic marker: ${marker}. Reply with only the marker. Do not use tools.`,
      'Reply with only the diagnostic marker from my previous message. Do not use tools.',
      'Reply exactly WAKE_FIRST. Do not use tools.', 'Reply exactly WAKE_SECOND. Do not use tools.',
    ])
    expect(initial.initialization).toEqual({ commands: [{ name: 'compact', description: 'Compact native context.' }],
      models: [{ value: 'fixture-model', resolvedModel: 'fixture-model', displayName: 'fixture-model',
        supportedEffortLevels: ['low', 'medium', 'high', 'max'] }], permissionMode: 'default',
      account: { apiProvider: 'firstParty', tokenSource: 'conformance-fixture' } })
    expect(initial.results.map(result => result.result)).toEqual([marker, marker, 'WAKE_FIRST', 'WAKE_SECOND'])
    expect(initial.results.map(result => result.user_message_uuids)).toEqual(initial.messages.map(message => [message.uuid]))
    const id = initial.results[0].session_id
    expect(initial.results.every(result => result.session_id === id && result.is_error === false)).toBe(true)
    const resumed = await runTurns(fixture, ['Reply with only the diagnostic marker from our first message. Do not use tools.'], { resume: id })
    expect(resumed.results.map(result => [result.session_id, result.result])).toEqual([[id, marker]])
    const before = await fixture.sdk.getSessionMessages(id, { dir: fixture.options.cwd })
    const fork = await fixture.sdk.forkSession(id, { dir: fixture.options.cwd })
    expect(fork.sessionId).not.toBe(id)
    const forked = await fixture.sdk.getSessionMessages(fork.sessionId, { dir: fixture.options.cwd })
    expect(forked).toEqual(before.map(frame => ({ ...frame, session_id: fork.sessionId })))
    expect(await fixture.sdk.getSessionMessages(id, { dir: fixture.options.cwd })).toEqual(before)
    await expect(fixture.sdk.getSessionMessages(id, { dir: fixture.directory })).rejects.toThrow('original session')
  })

  it('creates only the allowed diagnostic file and retains a real hook denial without another tool attempt', async () => {
    const fixture = await nativeFixture()
    const allowed = join(fixture.directory, 'outside.txt')
    const denied = join(fixture.directory, 'denied.txt')
    const marker = `OWNED_WRITE_${randomUUID()}`
    const events = []
    const options = { canUseTool: async (name, input) => {
      events.push(['permission', name, input.file_path])
      return { behavior: 'allow', updatedInput: input }
    }, hooks: {
      PreToolUse: [{ hooks: [async input => {
        events.push(['pre', input.tool_name, input.tool_input.file_path])
        return { hookSpecificOutput: { permissionDecision: input.tool_input.file_path === denied ? 'deny' : 'ask' } }
      }] }],
      PostToolUse: [{ hooks: [async input => { events.push(['post', input.tool_name, input.tool_input.file_path]); return {} }] }],
    } }
    const actual = await runTurns(fixture, [
      `Use Write to put exactly ${marker} in ${allowed}. This is an owned disposable diagnostic file. Then reply DONE.`,
      `Use Write to put exactly BLOCKED in ${denied}. If the diagnostic policy denies it, do not retry or use another tool. Reply DONE.`,
    ], options)
    expect(await readFile(allowed, 'utf8')).toBe(marker)
    await expect(readFile(denied)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(events).toEqual([['pre', 'Write', allowed], ['permission', 'Write', allowed], ['post', 'Write', allowed], ['pre', 'Write', denied]])
    const toolResults = actual.frames.filter(frame => frame.type === 'user' && Array.isArray(frame.message.content))
      .flatMap(frame => frame.message.content)
    expect(toolResults.map(result => result.is_error)).toEqual([false, true])
    expect(JSON.parse(toolResults[0].content)).toEqual({ filePath: allowed, bytesWritten: Buffer.byteLength(marker) })
    expect(JSON.parse(toolResults[1].content)).toEqual({ error: 'Tool request denied.' })
    expect(actual.results.map(result => [result.result, result.is_error])).toEqual([['DONE', false], ['DONE', false]])
  })

  it('rejects existing files, symlinks, foreign roots and sandbox-enabled physical writes', async () => {
    const fixture = await nativeFixture()
    const options = fixture.options
    const signal = AbortSignal.timeout(5000)
    const existing = join(fixture.directory, 'existing.txt')
    const link = join(fixture.directory, 'linked.txt')
    await writeFile(existing, 'Keep the original bytes', { flag: 'wx' })
    await symlink(existing, link)
    const write = (file_path, override = {}) => fixture.native.writeClaudeOwnedFile({ file_path, content: 'new' },
      { ...options, ...override }, signal)
    await expect(write(existing)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(write(link)).rejects.toMatchObject({ code: 'EEXIST' })
    const foreign = join(tmpdir(), `conformance-claude-foreign-${randomUUID()}.txt`)
    await expect(write(foreign)).rejects.toThrow('isolated target')
    const sandboxed = join(fixture.directory, 'sandboxed.txt')
    await expect(write(sandboxed, { sandbox: { enabled: true } })).rejects.toThrow('sandbox mode')
    expect(await readFile(existing, 'utf8')).toBe('Keep the original bytes')
    await expect(readFile(foreign)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sandboxed)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not invoke an undeclared built-in tool or turn a delivered permission denial into a write', async () => {
    const fixture = await nativeFixture()
    const path = join(fixture.directory, 'not-written.txt')
    for (const options of [
      { ...fixture.options, tools: [] },
      { ...fixture.options, disallowedTools: ['Write'] },
      { ...fixture.options, canUseTool: async () => ({ behavior: 'deny', message: 'The owner declined this write.' }) },
    ]) {
      const frames = []
      expect(await fixture.tools.executeTool({ options, session: { sessionId: randomUUID(), cwd: options.cwd },
        model: 'fixture-model', signal: AbortSignal.timeout(5000), transcriptPath: join(fixture.directory, 'transcript'),
        emit: frame => frames.push(frame) }, { uuid: randomUUID() }, { name: 'Write', input: { file_path: path, content: 'blocked' } })).toBe(false)
      expect(frames[1].message.content[0].is_error).toBe(true)
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
