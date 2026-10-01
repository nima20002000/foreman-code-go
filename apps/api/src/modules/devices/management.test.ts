import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { DeviceRegistration } from '@graphql/contracts/device-identity'
import { describe, expect, it } from 'vitest'
import { registerDeviceManagementTools } from './management.js'
import type { PostgresDeviceAccessService } from './access.js'

describe('device Operator MCP shared service', () => {
  it('exposes persisted readback and removes write tools for denied callers', async () => {
    const registration: DeviceRegistration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 2, status: 'revoked', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
    const service = { list: async () => [registration] } as unknown as PostgresDeviceAccessService
    const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read'], scope: {} }] }
    const server = new McpServer({ name: 'device-test', version: '1' })
    registerDeviceManagementTools(server, service, principal)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'reader', version: '1' })
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['devices_list'])
      const result = await client.callTool({ name: 'devices_list', arguments: {} })
      expect(result.structuredContent).toEqual({ devices: [registration] })
      const denied = await client.callTool({ name: 'device_revoke', arguments: { deviceId: registration.deviceId, expectedRevision: 2, commandId: 'denied-test' } })
      expect(denied.isError).toBe(true)
    } finally { await client.close(); await server.close() }
  })
})
