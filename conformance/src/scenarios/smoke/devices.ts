import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  DeviceListResultSchema,
  DevicePairingGrantInputSchema,
  DevicePairingGrantResultSchema,
  DeviceRegistrationSchema,
  DeviceRevokeInputSchema,
  MainDeviceIdentityPublicSchema,
  type DeviceRegistration,
} from '@foreman-code/contracts/device-identity'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { assertResponse } from '../../assertions.js'
import { connectTestWorker, pairTestWorker } from '../../clients/worker.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { httpCoverage } from './support.js'

async function pairFreshWorker(ctx: ScenarioContext) {
  assert.ok(ctx.target.deviceEndpoint, 'The target must expose its isolated TLS device listener')
  assert.ok(ctx.target.deviceTlsTrust, 'The test worker must verify the selected device certificate')
  let mainId: string | undefined
  let pending: DeviceRegistration | undefined
  const paired = await pairTestWorker({
    baseUrl: ctx.target.baseUrl,
    deviceEndpoint: ctx.target.deviceEndpoint,
    deviceTlsTrust: ctx.target.deviceTlsTrust,
    appVersion: ctx.target.applicationVersion,
    signal: ctx.signal,
    async managementRequest(method, path, body) {
      const response = await ctx.http.request(method, path, { body })
      if (path === '/api/devices/main') {
        const main = MainDeviceIdentityPublicSchema.parse(response.body)
        assertResponse(response, { status: 200, body: {
          mainId: '<uuid>', mainPublicKey: main.mainPublicKey,
          mainPublicKeyFingerprint: publicKeyFingerprint(main.mainPublicKey),
        } }, [{ pointer: '/body/mainId', kind: 'uuid' }])
        mainId = main.mainId
      } else {
        assert.equal(path, '/api/devices/pairing-grants')
        assert.ok(mainId)
        const input = DevicePairingGrantInputSchema.parse(body)
        const grant = DevicePairingGrantResultSchema.parse(response.body)
        assertResponse(response, { status: 200, body: {
          registration: {
            mainId, deviceId: '<uuid>', workerInstallationId: input.workerInstallationId,
            publicKeyFingerprint: input.expectedFingerprint, keyRevision: 1,
            authorizationRevision: 1, status: 'pending', scopes: input.scopes,
          },
          grant: grant.grant, expiresAt: '<timestamp>',
        } }, [
          { pointer: '/body/registration/deviceId', kind: 'uuid' },
          { pointer: '/body/expiresAt', kind: 'timestamp' },
        ])
        pending = grant.registration
      }
      return response
    },
  })
  assert.ok(pending)
  assert.deepStrictEqual(paired.registration, { ...pending, status: 'paired' })
  return paired
}

async function readDevices(ctx: ScenarioContext, devices: DeviceRegistration[]) {
  const response = await ctx.http.request('GET', '/api/devices')
  DeviceListResultSchema.parse(response.body)
  assertResponse(response, { status: 200, body: { devices } })
}

export const deviceScenarios: Scenario[] = [
  {
    id: 'devices.empty-registration-list', title: 'A fresh installation has no paired worker registrations', lane: 'R',
    covers: [httpCoverage('GET', '/api/devices', 'success')],
    async run(ctx) {
      await readDevices(ctx, [])
    },
  },
  {
    id: 'devices.pair-connect-read', title: 'A fresh worker pairs, proves the Main identity and completes WebSocket readiness', lane: 'R',
    covers: [httpCoverage('GET', '/api/devices/main', 'success'),
      httpCoverage('POST', '/api/devices/pairing-grants', 'success'), httpCoverage('GET', '/api/devices', 'success')],
    async run(ctx) {
      const { pairing, registration } = await pairFreshWorker(ctx)
      const worker = await connectTestWorker({
        pairing, appVersion: ctx.target.applicationVersion, signal: ctx.signal,
      })
      try {
        await worker.ready()
        const binding = worker.currentBinding()
        assert.equal(binding.mainId, registration.mainId)
        assert.equal(binding.deviceId, registration.deviceId)
        assert.equal(binding.workerInstallationId, registration.workerInstallationId)
        assert.equal(binding.keyRevision, 1)
        assert.equal(binding.authorizationRevision, 1)
        await readDevices(ctx, [registration])
      } finally {
        await worker.close()
      }
    },
  },
  {
    id: 'devices.revoke-replay-read', title: 'Worker revocation increments authorization once and preserves its command receipt', lane: 'R',
    covers: [httpCoverage('POST', '/api/devices/revoke', 'success'), httpCoverage('GET', '/api/devices', 'success')],
    async run(ctx) {
      const { registration } = await pairFreshWorker(ctx)
      const input = DeviceRevokeInputSchema.parse({
        deviceId: registration.deviceId, expectedRevision: registration.authorizationRevision, commandId: randomUUID(),
      })
      const expected = DeviceRegistrationSchema.parse({
        ...registration, status: 'revoked', authorizationRevision: registration.authorizationRevision + 1,
      })
      const response = await ctx.http.request('POST', '/api/devices/revoke', { body: input })
      DeviceRegistrationSchema.parse(response.body)
      assertResponse(response, { status: 200, body: expected })
      const replay = await ctx.http.request('POST', '/api/devices/revoke', { body: input })
      assertResponse(replay, { status: 200, body: expected })
      await readDevices(ctx, [expected])
    },
  },
]
