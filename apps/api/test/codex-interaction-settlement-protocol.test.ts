import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { protocolFromBundle, QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'
import { translateCodexInteraction, resolveCodexInteractionResponse } from '../src/modules/harnesses/codexInteractions.js'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'

it('validates user answers and form content against the pinned native Codex protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-interaction-schema-'))
  const binary = fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url))
  const execute = promisify(execFile)
  try {
    const version = await execute(binary, ['--version'])
    expect(version.stdout.trim()).toBe(QUALIFIED_CODEX_VERSION)
    await execute(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', directory])
    const protocol = protocolFromBundle(JSON.parse(await readFile(join(directory, 'codex_app_server_protocol.schemas.json'), 'utf8')))
    const requests = [
      { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn',
        itemId: 'question', isBlocking: true, questions: [{ id: 'generic', header: 'Question', question: 'Answer?',
          isOther: true, isSecret: false, options: null }] } },
      { id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn',
        mode: 'form', serverName: 'app', message: 'Enter email', requestedSchema: { type: 'object',
          properties: { email: { type: 'string' } }, required: ['email'] } } },
    ]
    for (const request of requests) {
      protocol.serverRequest(request)
      const translated = translateCodexInteraction({
        session: { harness: 'codex', nativeSessionId: 'thread', providerVersion: QUALIFIED_CODEX_VERSION },
        configuration: DEFAULT_HARNESS_DEFAULTS.codex, connectionId: 'connection', generation: 1,
      }, request)!
      const option = translated.pending.responseOptions[0]!
      const response = request.method === 'item/tool/requestUserInput'
        ? { generic: { answers: ['Entered answer'] } } : { email: 'user@example.com' }
      protocol.serverResponse(request.method,
        resolveCodexInteractionResponse(translated.responses.get(option.optionId)!, { ...option, response }))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
