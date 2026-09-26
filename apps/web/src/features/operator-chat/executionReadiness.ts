import { ExecutionReadinessSchema } from '@graphql/contracts/management'
import type { AgentHarness } from '@graphql/contracts'
import { apiClient } from '../../shared/api/client'

export function getExecutionReadiness(harness: AgentHarness, signal?: AbortSignal) {
  return apiClient.request(`/api/management/harnesses/${harness}/execution-readiness`, ExecutionReadinessSchema, { signal })
}
