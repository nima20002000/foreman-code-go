import type { Scenario } from '../../scenario.js'
import { ordinaryWorkflowScenarios } from './ordinary.js'
import { repeatWorkflowScenarios } from './repeat.js'
import { retryWorkflowScenarios } from './retry.js'
import { stopWorkflowScenarios } from './stop.js'
import { intervalWorkflowScenarios } from './interval.js'
import { restartWorkflowScenarios } from './restart.js'
import { joinWorkflowScenarios } from './join.js'
import { handoffWorkflowScenarios } from './handoff.js'
import { interactionWorkflowScenarios } from './interaction.js'
import { scheduledWorkflowScenarios } from './schedule.js'

export const workflowScenarios: Scenario[] = [
  ...ordinaryWorkflowScenarios, ...repeatWorkflowScenarios, ...retryWorkflowScenarios, ...stopWorkflowScenarios,
  ...intervalWorkflowScenarios, ...restartWorkflowScenarios,
  ...joinWorkflowScenarios,
  ...handoffWorkflowScenarios,
  ...interactionWorkflowScenarios,
  ...scheduledWorkflowScenarios,
]
