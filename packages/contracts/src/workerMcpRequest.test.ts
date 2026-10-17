import { expect, it } from 'vitest'
import { MAX_FILE_BYTES } from './files.js'
import { decodeWorkerMcpRequest, encodeWorkerMcpRequest } from './workerMcpRelay.js'

function referenceRequest(contentBase64: string) {
  return { operation: 'conversation-mcp.request', token: 'scoped-token', body: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reference_file_add', arguments: {
      scope: { kind: 'workspace_reference', workspaceId: 'workspace' },
      upload: { byteSize: MAX_FILE_BYTES, filename: 'reference.bin' }, contentBase64,
    } },
  } }
}

it('transfers full-size reference content as raw bytes and restores the original MCP request', () => {
  const bytes = Buffer.alloc(MAX_FILE_BYTES)
  for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 256
  const request = referenceRequest(bytes.toString('base64'))
  const carrier = encodeWorkerMcpRequest(request)
  expect(carrier.bytes?.byteLength).toBe(MAX_FILE_BYTES)
  expect(Buffer.compare(Buffer.from(carrier.bytes!), bytes)).toBe(0)
  expect(JSON.stringify(carrier.payload).length).toBeLessThan(1024)
  expect(decodeWorkerMcpRequest(carrier)).toEqual(request)
})

it('rejects incomplete reference binary carriers', () => {
  const request = referenceRequest(Buffer.alloc(2 * 1024 * 1024).toString('base64'))
  const carrier = encodeWorkerMcpRequest(request)
  expect(() => decodeWorkerMcpRequest({ payload: carrier.payload })).toThrow('missing')
  expect(() => decodeWorkerMcpRequest({ payload: carrier.payload, bytes: carrier.bytes!.subarray(1) }))
    .toThrow('length')
})

it('keeps unrelated binary MCP bodies intact', () => {
  const request = { operation: 'worker-mcp.request', applicationAccess: { token: 'scoped-token' },
    body: { method: 'tools/call', params: { name: 'other_tool', arguments: { text: 'x'.repeat(2 * 1024 * 1024) } } } }
  expect(decodeWorkerMcpRequest(encodeWorkerMcpRequest(request))).toEqual(request)
})
