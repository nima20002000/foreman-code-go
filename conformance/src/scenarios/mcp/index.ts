import type { Scenario } from '../../scenario.js'
import { conversationMcpScenarios } from './conversations.js'
import { settingScenarios } from './settings.js'
import { workspaceMcpScenarios } from './workspaces.js'

export const mcpScenarios: Scenario[] = [
  ...settingScenarios,
  ...workspaceMcpScenarios,
  ...conversationMcpScenarios,
]
