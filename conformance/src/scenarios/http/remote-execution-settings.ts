import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DEFAULT_REMOTE_EXECUTION_SETTINGS,
  RemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateInputSchema,
  RemoteExecutionSettingsUpdateResultSchema,
  type RemoteExecutionRuntimeStatus,
  type RemoteExecutionSettings,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'

const settingsPath = '/api/management/settings/remote-execution'
const environmentOverrides = [
  'FOREMAN_CODE_DEVICE_LISTENER_ENABLED',
  'DEVICE_LISTENER_HOST',
  'DEVICE_LISTENER_PORT',
  'DEVICE_LISTENER_TLS_CERT_FILE',
  'DEVICE_LISTENER_TLS_KEY_FILE',
  'DEVICE_LISTENER_ADVERTISED_ENDPOINT',
  'DEVICE_LISTENER_TLS_TRUST_CERT_FILE',
]

function listenerFixture(ctx: ScenarioContext) {
  const environment = ctx.target.environment
  for (const key of environmentOverrides) assert.ok(environment[key], `The launcher must supply ${key}`)
  assert.equal(environment.FOREMAN_CODE_DEVICE_LISTENER_ENABLED, '1')
  assert.equal(environment.DEVICE_LISTENER_HOST, '127.0.0.1')
  assert.equal(environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED, undefined)
  assert.ok(ctx.target.deviceEndpoint, 'The launcher must expose its fresh device listener')
  assert.equal(environment.DEVICE_LISTENER_ADVERTISED_ENDPOINT, ctx.target.deviceEndpoint)
  const listener = RemoteExecutionSettingsSchema.shape.listener.parse({
    enabled: true,
    host: environment.DEVICE_LISTENER_HOST,
    port: Number(environment.DEVICE_LISTENER_PORT),
    certificateFile: environment.DEVICE_LISTENER_TLS_CERT_FILE,
    privateKeyFile: environment.DEVICE_LISTENER_TLS_KEY_FILE,
    advertisedEndpoint: environment.DEVICE_LISTENER_ADVERTISED_ENDPOINT,
    trustCertificateFile: environment.DEVICE_LISTENER_TLS_TRUST_CERT_FILE,
  })
  const runtime: RemoteExecutionRuntimeStatus = {
    listenerEnabled: true, listenerEndpoint: ctx.target.deviceEndpoint,
    restartRequired: false, reason: null,
  }
  return { listener, runtime }
}

export const remoteExecutionSettingsScenario: Scenario = {
  id: 'http.settings.remote-execution',
  title: 'Remote execution settings retain saved values, live listener overrides, and revision receipts',
  lane: 'R',
  covers: [
    ...readCoverage(settingsPath),
    httpCoverage('PUT', settingsPath, 'success'),
    httpCoverage('PUT', settingsPath, 'error'),
  ],
  async run(ctx) {
    const { listener, runtime } = listenerFixture(ctx)
    const managed = (value: RemoteExecutionSettings, revision: number, versionId: string | null) => ({
      value, revision, versionId, effective: { ...value, listener }, environmentOverrides, runtime,
    })
    await assertProtectedRead(ctx, settingsPath, managed(DEFAULT_REMOTE_EXECUTION_SETTINGS, 0, null))

    const value = RemoteExecutionSettingsSchema.parse({ ...DEFAULT_REMOTE_EXECUTION_SETTINGS, enabled: true })
    const input = RemoteExecutionSettingsUpdateInputSchema.parse({
      value, commandId: randomUUID(), expectedRevision: 0,
    })
    const response = await ctx.http.request('PUT', settingsPath, { body: input })
    const saved = RemoteExecutionSettingsUpdateResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200, body: { value: { value, revision: 1, versionId: '<id>' }, replayed: false, runtime },
    }, [{ pointer: '/body/value/versionId', kind: 'id' }])
    assertResponse(await ctx.http.request('PUT', settingsPath, { body: input }), {
      status: 200, body: { value: saved, replayed: true, runtime },
    })
    assertApiError(await ctx.http.request('PUT', settingsPath, {
      body: { ...input, value: DEFAULT_REMOTE_EXECUTION_SETTINGS },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
    assertApiError(await ctx.http.request('PUT', settingsPath, {
      body: { ...input, commandId: randomUUID(), value: DEFAULT_REMOTE_EXECUTION_SETTINGS },
    }), 409, 'REVISION_CONFLICT', 'Defaults changed since they were read.', { currentRevision: 1 })

    const invalidListener = RemoteExecutionSettingsUpdateInputSchema.parse({
      commandId: randomUUID(), expectedRevision: 1,
      value: { ...value, listener: {
        ...value.listener, certificateFile: join(ctx.scenarioDirectory, 'missing-listener-certificate.pem'),
      } },
    })
    assertApiError(await ctx.http.request('PUT', settingsPath, { body: invalidListener }),
      400, 'REMOTE_EXECUTION_SETTINGS_INVALID',
      'Use a separate listener port and valid TLS files owned by Main’s OS user with owner-only permissions.')
    await assertProtectedRead(ctx, settingsPath, managed(value, 1, saved.versionId))
    await ctx.target.restart()
    await assertProtectedRead(ctx, settingsPath, managed(value, 1, saved.versionId))

    const restored = await ctx.http.request('PUT', settingsPath, { body: RemoteExecutionSettingsUpdateInputSchema.parse({
      value: DEFAULT_REMOTE_EXECUTION_SETTINGS, commandId: randomUUID(), expectedRevision: 1,
    }) })
    const restoredValue = RemoteExecutionSettingsUpdateResultSchema.parse(restored.body).value
    assertResponse(restored, {
      status: 200, body: {
        value: { value: DEFAULT_REMOTE_EXECUTION_SETTINGS, revision: 2, versionId: '<id>' }, replayed: false, runtime,
      },
    }, [{ pointer: '/body/value/versionId', kind: 'id' }])
    await assertProtectedRead(ctx, settingsPath, managed(DEFAULT_REMOTE_EXECUTION_SETTINGS, 2, restoredValue.versionId))
  },
}
