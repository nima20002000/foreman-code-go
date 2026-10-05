import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { ExecutionAuthorityRequestSchema, EXECUTION_AUTHORITY_EXTENSION } from '@graphql/contracts/execution-authority'
import type { DeviceApplicationFrame } from '@graphql/contracts/device-application'
import { RemoteOwnerControlSchema } from '@graphql/contracts/remote-execution'

/** Forward actual paired frames unchanged. A test can delay authorization at
 * the network boundary; Main still performs the original scope checks. */
export async function createRemoteReviewTransport(input: {
  endpoint: string
  certificateFile: string
  privateKeyFile: string
  beforeAuthorization(request: ReturnType<typeof ExecutionAuthorityRequestSchema.parse>): Promise<void>
}) {
  const [cert, key] = await Promise.all([readFile(input.certificateFile), readFile(input.privateKeyFile)])
  const server = createServer({ cert, key })
  const sockets = new Set<WebSocket>()
  const deliveryReads: Array<{ command: ReturnType<typeof RemoteOwnerControlSchema.parse>; phase: string }> = []
  const websocket = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 16384 })
  websocket.on('connection', (worker, request) => {
    const main = new WebSocket(input.endpoint, { ca: cert,
      headers: { authorization: request.headers.authorization! }, perMessageDeflate: false })
    sockets.add(worker)
    sockets.add(main)
    const assemblies = new Map<string, { bytes: number; chunks: Buffer[]; received: number }>()
    const readRequests = new Map<string, ReturnType<typeof RemoteOwnerControlSchema.parse>>()
    const trace = new Map<string, { bytes: number; chunks: Buffer[]; received: number }>()
    const observe = (data: RawData, direction: 'to-worker' | 'to-main') => {
      const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
      const key = `${direction}:${'id' in frame ? frame.id : ''}`
      if (frame.type === 'application-open' && frame.namespace === 'execution-v1') {
        trace.set(key, { bytes: frame.jsonBytes, chunks: [], received: 0 })
      }
      if (frame.type !== 'application-chunk') return
      const assembly = trace.get(key)
      if (!assembly) return
      const chunk = Buffer.from(frame.data, 'base64')
      assembly.chunks.push(chunk)
      assembly.received += chunk.byteLength
      if (assembly.received !== assembly.bytes) return
      trace.delete(key)
      const payload = JSON.parse(Buffer.concat(assembly.chunks).toString('utf8')) as {
        method?: string; command?: unknown; phase?: string
      }
      if (direction === 'to-worker' && payload.method === 'control-delivery') {
        readRequests.set(frame.id, RemoteOwnerControlSchema.parse(payload.command))
      }
      const command = readRequests.get(frame.id)
      if (direction === 'to-main' && command && payload.phase) {
        deliveryReads.push({ command, phase: payload.phase })
        readRequests.delete(frame.id)
      }
    }
    let ready = false
    const waiting: RawData[] = []
    const fail = () => { worker.terminate(); main.terminate() }
    main.on('open', () => {
      ready = true
      for (const message of waiting.splice(0)) main.send(message)
    })
    main.on('message', data => {
      observe(data, 'to-worker')
      worker.send(data)
    })
    main.on('error', fail)
    worker.on('error', fail)
    main.on('close', () => { sockets.delete(main); worker.close() })
    worker.on('close', () => { sockets.delete(worker); main.close() })
    worker.on('message', data => {
      const forward = async () => {
        observe(data, 'to-main')
        const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
        if (frame.type === 'application-open' && frame.kind === 'request'
          && frame.namespace === EXECUTION_AUTHORITY_EXTENSION.namespace) {
          assemblies.set(frame.id, { bytes: frame.jsonBytes, chunks: [], received: 0 })
        }
        if (frame.type === 'application-chunk') {
          const assembly = assemblies.get(frame.id)
          if (assembly) {
            const chunk = Buffer.from(frame.data, 'base64')
            assembly.chunks.push(chunk)
            assembly.received += chunk.byteLength
            if (assembly.received === assembly.bytes) {
              assemblies.delete(frame.id)
              const parsed = ExecutionAuthorityRequestSchema.safeParse(
                JSON.parse(Buffer.concat(assembly.chunks).toString('utf8')))
              if (parsed.success) await input.beforeAuthorization(parsed.data)
            }
          }
        }
        if (ready) main.send(data)
        else waiting.push(data)
      }
      void forward().catch(fail)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback transport fixture port.')
  return { endpoint: `wss://127.0.0.1:${address.port}/device/connect`, deliveryReads,
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => websocket.close(error => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}
