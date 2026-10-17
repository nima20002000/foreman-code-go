import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, WorkflowDefaultsSchema } from '@foreman-code/contracts'
import {
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_PROMPT_TEXT,
  GeneralSettingsSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  PromptTextSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { versionedSettingScenario } from './versioned-setting.js'

export const settingsScenarios = [
  versionedSettingScenario({
    id: 'http.settings.agent-defaults',
    title: 'Agent display defaults preserve configuration, replay, and restart readback',
    path: '/api/management/settings/agents',
    initialValue: DEFAULT_AGENT_DEFAULTS,
    updatedValue: AgentDefaultsSchema.parse({
      ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, showThinking: false, uiEnabled: false },
    }),
    inputSchema: AgentDefaultsUpdateInputSchema,
    resultSchema: AgentDefaultsUpdateResultSchema,
    revisionConflict: { message: 'Agent defaults changed since they were read.' },
  }),
  versionedSettingScenario({
    id: 'http.settings.workflow-defaults',
    title: 'Workflow defaults preserve the selected approval handler and revision receipts',
    lane: 'E',
    path: '/api/management/settings/workflows',
    initialValue: WorkflowDefaultsSchema.parse({ approvalHandler: 'orchestrator' }),
    updatedValue: WorkflowDefaultsSchema.parse({ approvalHandler: 'user' }),
    inputSchema: WorkflowDefaultsUpdateInputSchema,
    resultSchema: WorkflowDefaultsUpdateResultSchema,
  }),
  versionedSettingScenario({
    id: 'http.settings.general',
    title: 'General settings preserve revision, replay, and restart readback',
    path: '/api/management/settings/general',
    initialValue: DEFAULT_GENERAL_SETTINGS,
    updatedValue: GeneralSettingsSchema.parse({ theme: 'light' }),
    inputSchema: GeneralSettingsUpdateInputSchema,
    resultSchema: GeneralSettingsUpdateResultSchema,
  }),
  versionedSettingScenario({
    id: 'http.settings.system-prompt',
    title: 'System prompt settings retain complete text and revision behavior',
    path: '/api/management/settings/system-prompt',
    initialValue: DEFAULT_PROMPT_TEXT,
    updatedValue: PromptTextSchema.parse({ text: 'Conformance system prompt.\nPreserve Unicode: λ ✓\n' }),
    inputSchema: PromptSettingUpdateInputSchema,
    resultSchema: PromptSettingUpdateResultSchema,
  }),
  versionedSettingScenario({
    id: 'http.settings.operator-initial-prompt',
    title: 'Operator initial prompt settings retain complete text and revision behavior',
    path: '/api/management/settings/operator-initial-prompt',
    initialValue: DEFAULT_PROMPT_TEXT,
    updatedValue: PromptTextSchema.parse({ text: 'Conformance operator prompt.\nKeep trailing spaces:  \n' }),
    inputSchema: PromptSettingUpdateInputSchema,
    resultSchema: PromptSettingUpdateResultSchema,
  }),
]
