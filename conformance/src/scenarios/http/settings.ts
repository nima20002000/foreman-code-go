import {
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_PROMPT_TEXT,
  GeneralSettingsSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  PromptTextSchema,
} from '@foreman-code/contracts/management'
import { versionedSettingScenario } from './versioned-setting.js'

export const settingsScenarios = [
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
