import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_GENERAL_SETTINGS, DEFAULT_PROMPT_TEXT, GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema, ManagedGeneralSettingsSchema, ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema, PromptSettingUpdateResultSchema,
} from '@foreman-code/contracts/management'
import type { Scenario } from '../../scenario.js'
import { assertResponse } from '../../assertions.js'
import { assertInvalidCallerDenied, assertReadOnlyDenied, assertToolFailure,
  assertValue, callTool, mcpClaims, operatorClients } from './support.js'

const prompts = [
  { name: 'system', get: 'system_prompt_get', update: 'system_prompt_update',
    path: '/api/management/settings/system-prompt', text: 'Conformance system prompt.\nPreserve Markdown and Unicode: café.' },
  { name: 'operator-initial', get: 'operator_initial_prompt_get', update: 'operator_initial_prompt_update',
    path: '/api/management/settings/operator-initial-prompt', text: 'Conformance Operator initial prompt.\nKeep this exact second line.' },
] as const

export const settingScenarios: Scenario[] = [
  ...prompts.map((setting): Scenario => ({
    id: `mcp.settings.${setting.name}`, title: `MCP ${setting.name} prompt permissions, revisions, replay and persisted readback`,
    lane: 'A1', authentication: 'operator', covers: mcpClaims(setting.get, setting.update),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      const initial = await callTool(operator, setting.get, {}, ManagedPromptSettingSchema)
      assertValue(initial, { value: DEFAULT_PROMPT_TEXT, revision: 0, versionId: null })
      const input = PromptSettingUpdateInputSchema.parse({ commandId: randomUUID(), expectedRevision: 0,
        value: { text: setting.text } })
      await assertInvalidCallerDenied(operator, setting.get, {})
      await assertReadOnlyDenied(readOnly, setting.update, input)
      assert.deepStrictEqual(await callTool(operator, setting.get, {}, ManagedPromptSettingSchema), initial)
      const changed = await callTool(operator, setting.update, input, PromptSettingUpdateResultSchema)
      assertValue(changed, { value: { value: input.value, revision: 1, versionId: '<id>' }, replayed: false },
        [{ pointer: '/body/value/versionId', kind: 'id' }])
      const replay = await callTool(operator, setting.update, input, PromptSettingUpdateResultSchema)
      assert.deepStrictEqual(replay, { ...changed, replayed: true })
      assertToolFailure(await operator.callTool(setting.update, { ...input, commandId: randomUUID() }), {
        code: 'REVISION_CONFLICT', message: 'Defaults changed since they were read.', details: { currentRevision: 1 },
      })
      await context.target.restart()
      assert.deepStrictEqual(await callTool(operator, setting.get, {}, ManagedPromptSettingSchema), changed.value)
      assertResponse(await context.http.request('GET', setting.path), { status: 200, body: changed.value })
      assert.deepStrictEqual(await callTool(operator, setting.update, input, PromptSettingUpdateResultSchema), replay)
    },
  })),
  {
    id: 'mcp.settings.general', title: 'MCP general preferences retain the exact revision and replay across restart',
    lane: 'A1', authentication: 'operator', covers: mcpClaims('general_settings_get', 'general_settings_update'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      const initial = await callTool(operator, 'general_settings_get', {}, ManagedGeneralSettingsSchema)
      assertValue(initial, { value: DEFAULT_GENERAL_SETTINGS, revision: 0, versionId: null })
      const input = GeneralSettingsUpdateInputSchema.parse({ commandId: randomUUID(), expectedRevision: 0, value: { theme: 'light' } })
      await assertInvalidCallerDenied(operator, 'general_settings_get', {})
      await assertReadOnlyDenied(readOnly, 'general_settings_update', input)
      assert.deepStrictEqual(await callTool(operator, 'general_settings_get', {}, ManagedGeneralSettingsSchema), initial)
      const changed = await callTool(operator, 'general_settings_update', input, GeneralSettingsUpdateResultSchema)
      assertValue(changed, { value: { value: { theme: 'light' }, revision: 1, versionId: '<id>' }, replayed: false },
        [{ pointer: '/body/value/versionId', kind: 'id' }])
      assertToolFailure(await operator.callTool('general_settings_update', { ...input, commandId: randomUUID() }), {
        code: 'REVISION_CONFLICT', message: 'Defaults changed since they were read.', details: { currentRevision: 1 },
      })
      await context.target.restart()
      assert.deepStrictEqual(await callTool(operator, 'general_settings_get', {}, ManagedGeneralSettingsSchema), changed.value)
      assertResponse(await context.http.request('GET', '/api/management/settings/general'), { status: 200, body: changed.value })
      assert.deepStrictEqual(await callTool(operator, 'general_settings_update', input, GeneralSettingsUpdateResultSchema),
        { ...changed, replayed: true })
    },
  },
]
