import { z } from 'zod'
import { ScenarioIdSchema, type ScenarioId } from '@graphql/contracts'

import { apiClient, type RequestOptions } from '../api/client'

export const MockScenarioResponseSchema = z
  .object({
    scenarioId: ScenarioIdSchema,
    failureMode: z.enum(['none', 'graph-save', 'user-message', 'all']),
    scenarios: z.array(ScenarioIdSchema),
  })
  .strict()

export type MockScenarioResponse = z.infer<typeof MockScenarioResponseSchema>

export function getMockScenario(options?: RequestOptions) {
  return apiClient.request<MockScenarioResponse>('/api/mock/scenario', MockScenarioResponseSchema, options)
}

export function selectMockScenario(
  scenarioId: ScenarioId,
  failureMode: MockScenarioResponse['failureMode'] = 'none',
  options?: RequestOptions,
) {
  return apiClient.request<MockScenarioResponse>('/api/mock/scenario', MockScenarioResponseSchema, {
    ...options,
    method: 'POST',
    body: { scenarioId, failureMode },
  })
}

export function resetMockScenario(options?: RequestOptions) {
  return apiClient.request<MockScenarioResponse>('/api/mock/reset', MockScenarioResponseSchema, {
    ...options,
    method: 'POST',
  })
}

export function setMockFailureMode(
  failureMode: MockScenarioResponse['failureMode'],
  options?: RequestOptions,
) {
  return apiClient.request<MockScenarioResponse>('/api/mock/failures', MockScenarioResponseSchema, {
    ...options,
    method: 'POST',
    body: { failureMode },
  })
}
