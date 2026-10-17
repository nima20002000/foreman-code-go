import { randomUUID } from 'node:crypto'
import type { ApiError } from '@foreman-code/contracts'
import type {
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Lane } from '../../reporting/types.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'

interface SettingRoundTrip {
  id: string
  title: string
  lane?: Lane
  path: string
  initialValue: unknown
  updatedValue: unknown
  inputSchema: typeof GeneralSettingsUpdateInputSchema | typeof PromptSettingUpdateInputSchema
    | typeof AgentDefaultsUpdateInputSchema | typeof WorkflowDefaultsUpdateInputSchema
  resultSchema: typeof GeneralSettingsUpdateResultSchema | typeof PromptSettingUpdateResultSchema
    | typeof AgentDefaultsUpdateResultSchema | typeof WorkflowDefaultsUpdateResultSchema
  revisionConflict?: Pick<ApiError, 'message' | 'details'>
}

export function versionedSettingScenario(setting: SettingRoundTrip): Scenario {
  return {
    id: setting.id,
    title: setting.title,
    lane: setting.lane ?? 'A2',
    covers: [
      ...readCoverage(setting.path),
      httpCoverage('PUT', setting.path, 'success'),
      httpCoverage('PUT', setting.path, 'error'),
    ],
    async run(ctx) {
      await assertProtectedRead(ctx, setting.path, {
        value: setting.initialValue, revision: 0, versionId: null,
      })
      const input = setting.inputSchema.parse({
        value: setting.updatedValue, commandId: randomUUID(), expectedRevision: 0,
      })
      const response = await ctx.http.request('PUT', setting.path, { body: input })
      const saved = setting.resultSchema.parse(response.body).value
      assertResponse(response, {
        status: 200,
        body: { value: { value: setting.updatedValue, revision: 1, versionId: '<id>' }, replayed: false },
      }, [{ pointer: '/body/value/versionId', kind: 'id' }])
      assertResponse(await ctx.http.request('PUT', setting.path, { body: input }), {
        status: 200, body: { value: saved, replayed: true },
      })
      assertApiError(await ctx.http.request('PUT', setting.path, {
        body: { ...input, value: setting.initialValue },
      }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
      const conflict = setting.revisionConflict ?? {
        message: 'Defaults changed since they were read.', details: { currentRevision: 1 },
      }
      assertApiError(await ctx.http.request('PUT', setting.path, {
        body: { ...input, commandId: randomUUID(), value: setting.initialValue },
      }), 409, 'REVISION_CONFLICT', conflict.message, conflict.details)
      await assertProtectedRead(ctx, setting.path, saved)
      await ctx.target.restart()
      await assertProtectedRead(ctx, setting.path, saved)

      const overwrite = setting.inputSchema.parse({ value: setting.initialValue, commandId: randomUUID() })
      const overwritten = await ctx.http.request('PUT', setting.path, { body: overwrite })
      const restored = setting.resultSchema.parse(overwritten.body).value
      assertResponse(overwritten, {
        status: 200,
        body: { value: { value: setting.initialValue, revision: 2, versionId: '<id>' }, replayed: false },
      }, [{ pointer: '/body/value/versionId', kind: 'id' }])
      await assertProtectedRead(ctx, setting.path, restored)
    },
  }
}
