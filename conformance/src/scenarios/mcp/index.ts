import type { Scenario } from '../../scenario.js'
import { conversationMcpScenarios } from './conversations.js'
import { settingScenarios } from './settings.js'
import { workspaceMcpScenarios } from './workspaces.js'
import { workerRootMcpScenarios } from './workerRoots.js'
import { workflowMetadataMcpScenario } from './workflowMetadata.js'

export const mcpScenarios: Scenario[] = [
  ...settingScenarios,
  ...workspaceMcpScenarios,
  ...conversationMcpScenarios,
  ...workerRootMcpScenarios,
  workflowMetadataMcpScenario,
]
