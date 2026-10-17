import type { Scenario } from '../../scenario.js'
import { conversationScenarios } from './conversations.js'
import { deviceScenarios } from './devices.js'
import { harnessScenarios } from './harnesses.js'
import { healthScenarios } from './health.js'
import { jobScenarios } from './jobs.js'
import { runScenarios } from './runs.js'
import { sourceScenarios } from './sources.js'
import { workspaceScenarios } from './workspaces.js'

export const smokeScenarios: Scenario[] = [
  ...healthScenarios,
  ...runScenarios,
  ...harnessScenarios,
  ...jobScenarios,
  ...conversationScenarios,
  ...sourceScenarios,
  ...deviceScenarios,
  ...workspaceScenarios,
]
