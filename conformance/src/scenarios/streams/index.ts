import type { Scenario } from '../../scenario.js'
import { operatorStreamScenarios } from './operator.js'
import { agentStreamScenarios } from './agent.js'

export const streamScenarios: Scenario[] = [...operatorStreamScenarios, ...agentStreamScenarios]
