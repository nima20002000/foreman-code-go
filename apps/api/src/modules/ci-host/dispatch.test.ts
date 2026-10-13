import { randomUUID } from 'node:crypto'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { ciMessages } from './dispatch.js'

it.each([{}, { providerMessage: null, messageHistory: [] }])(
  'preserves optional message fields when the provider has no new message: %j',
  metadata => {
    const run = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId: randomUUID(), groupId: randomUUID(),
      suite: 'lint', commit: 'a'.repeat(40), repository: 'example/project',
      partition: null, state: 'running', computer: null, step: 'lint',
      exitCode: null, message: null, queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null,
      initiator: { principalId: randomUUID(), executionId: null },
      ...metadata,
    })

    expect({ ...run, ...ciMessages(run, null) }).toEqual(run)
  },
)
