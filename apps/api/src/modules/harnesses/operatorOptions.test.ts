import { expect, it } from 'vitest'
import { codexModelOptions, harnessSettingSupport } from './operatorOptions.js'

it('retains Codex catalog and setting metadata after retiring another provider', () => {
  expect(codexModelOptions({ models: [{ slug: 'codex-model', display_name: 'Codex Model',
    supported_reasoning_levels: [{ effort: 'medium' }], additional_speed_tiers: ['fast'], priority: 1 }] }))
    .toEqual([{ id: 'codex-model', name: 'Codex Model', reasoningEfforts: ['medium'], variants: [],
      serviceTiers: ['standard', 'priority'], defaultPriority: 1 }])
  expect(harnessSettingSupport().map(setting => setting.field)).toEqual([
    'model', 'reasoningEffort', 'serviceTier', 'sandbox', 'advanced.approvalPolicy',
    'advanced.approvalsReviewer', 'advanced.additionalWritableDirectories', 'advanced.workspaceWrite',
    'advanced.sessionPersistence', 'advanced.shellEnvironment', 'advanced.webSearch', 'advanced.mcpServers',
  ])
})
