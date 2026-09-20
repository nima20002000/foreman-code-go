import { expect, it } from 'vitest'
import { pendingOperatorSetupTarget } from './operatorSetupTarget'
import type { SendOperatorMessageRequest } from '@graphql/contracts'

it.each(['codex', 'opencode'] as const)('checks the original %s pending command, never the other shared harness', (harness) => {
  const settings = harness === 'codex' ? { harness, model: 'saved', reasoningEffort: 'medium', serviceTier: 'standard', showThinking: false }
    : { harness, model: 'saved', variant: 'max', showThinking: false }
  const command = { requestId: 'original-id', content: 'original prompt', configurationVersionId: 'accepted-version', settings } as SendOperatorMessageRequest
  const before = structuredClone(command)
  const query = pendingOperatorSetupTarget('conversation', command)
  expect(query).toEqual({ conversationId: 'conversation', requestId: 'original-id', harness, configurationVersionId: 'accepted-version' })
  expect(query).not.toHaveProperty('expectedDefaultsRevision')
  expect(command).toEqual(before)
})
