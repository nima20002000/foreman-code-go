import type { Scenario } from '../../scenario.js'
import { workspaceMutationScenario } from './workspaces.js'
import { workspaceArchiveScenario, workspaceBatchArchiveScenario } from './workspace-archive.js'
import { settingsScenarios } from './settings.js'
import { workspaceDefaultsScenario } from './workspace-defaults.js'
import { workflowMetadataScenario } from './workflow-metadata.js'
import { workflowOrderScenario } from './workflow-order.js'
import { workflowScheduleScenario } from './workflow-schedules.js'
import { skillVersionScenario } from './skill-versions.js'
import { skillArchiveScenario } from './skill-archive.js'
import { bugReportScenario } from './bug-reports.js'
import { workflowVersionScenario } from './workflow-versions.js'
import { agentScenario } from './agents.js'
import { skillConsumerScenario } from './skill-consumers.js'
import { authenticationScenarios } from './authentication.js'
import { remoteExecutionSettingsScenario } from './remote-execution-settings.js'
import { fileRetentionScenario } from './file-retention.js'
import { fileReferenceScenarios } from './file-references.js'
import { conversationFilesScenario } from './conversation-files.js'
import { workspaceRootsScenario } from './workspace-roots.js'
import { workspaceProductScenario } from './workspace-product.js'

export const httpScenarios: Scenario[] = [
  workspaceMutationScenario,
  workspaceArchiveScenario,
  workspaceBatchArchiveScenario,
  ...settingsScenarios,
  remoteExecutionSettingsScenario,
  fileRetentionScenario,
  ...fileReferenceScenarios,
  conversationFilesScenario,
  workspaceRootsScenario,
  workspaceDefaultsScenario,
  workflowMetadataScenario,
  workflowOrderScenario,
  workflowScheduleScenario,
  skillVersionScenario,
  skillArchiveScenario,
  bugReportScenario,
  workflowVersionScenario,
  agentScenario,
  skillConsumerScenario,
  ...authenticationScenarios,
  workspaceProductScenario,
]
