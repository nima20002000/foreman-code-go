import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { nonempty, object, requireCondition } from './checks.js'

type NativeRequest = (path: string, body?: Record<string, unknown>) => Promise<unknown>

/** Real native storage round trips qualify idle child input without application credentials. */
export async function qualifyOpenCodeSubagentInput(request: NativeRequest, parentSessionId: string, selectedModel?: string | null) {
  const parentBefore = object(await request(`/session/${parentSessionId}`))
  const child = object(await request('/session', { parentID: parentSessionId, title: 'Child input qualification',
    permission: [{ permission: '*', pattern: '*', action: 'deny' }] }))
  const childSessionId = nonempty(child.id, 'child ID')
  requireCondition(child.parentID === parentSessionId, 'The child does not belong to the qualification parent.')
  const selected = selectedModel?.split('/')
  const model = selected ? { providerID: selected[0], modelID: selected.slice(1).join('/') }
    : { providerID: object(parentBefore.model).providerID, modelID: object(parentBefore.model).id }
  for (const text of ['Complete the child task.', 'Continue this same child task.']) {
    const messageID = `msg_${randomUUID().replaceAll('-', '')}`
    const result = object(await request(`/session/${childSessionId}/message`, {
      messageID, agent: 'plan', model, variant: '', system: 'Child control qualification.', parts: [{ type: 'text', text }],
    }))
    const info = object(result.info)
    requireCondition(!info.error && typeof object(info.time).completed === 'number', 'Child turn failed.')
    const user = object(await request(`/session/${childSessionId}/message/${messageID}`))
    const stored = object(user.info)
    requireCondition(stored.agent === 'plan' && stored.system === 'Child control qualification.'
      && object(stored.model).providerID === model.providerID && object(stored.model).modelID === model.modelID
      && object(stored.model).variant === '', 'Child input did not preserve its configuration.')
  }
  const parentAfter = await request(`/session/${parentSessionId}`)
  requireCondition(isDeepStrictEqual(parentAfter, parentBefore), 'Child input changed the parent.')
  return { childSessionId, parentSessionId, timing: 'idle' as const }
}
