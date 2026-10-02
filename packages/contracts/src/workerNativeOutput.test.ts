import { describe, expect, it } from 'vitest'
import { WorkerNativeOutputCommandSchema, WorkerNativeOutputBytesSchema, WORKER_NATIVE_OUTPUT_FILE_OPERATIONS } from './workerNativeOutput.js'
import { WorkerMcpRelayRequestSchema } from './workerMcpRelay.js'

describe('closed worker native output commands', () => {
  const create = { operation: 'create', commandId: 'create-command', filename: 'result.md', mediaType: 'text/markdown' }
  it('validates file metadata and prohibits caller-selected scope, path and identity', () => {
    expect(WorkerNativeOutputCommandSchema.parse(create)).toEqual(create)
    for (const key of ['path', 'scope', 'executionId', 'nativeSessionId', 'turnId', 'root']) {
      expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, [key]: '/foreign' }).success).toBe(false)
    }
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, filename: 'result.pdf' }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, filename: '../result.md' }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, commandId: 'short' }).success).toBe(false)
  })
  it('limits decoded append bytes and requires canonical base64 including zero padding bits', () => {
    expect(WorkerNativeOutputBytesSchema.parse(Buffer.alloc(65536).toString('base64'))).toBeTruthy()
    for (const value of [Buffer.alloc(65537).toString('base64'), 'Zh==', 'Zm9=', 'Zg', 'Zg==\n', '_w==']) {
      expect(WorkerNativeOutputBytesSchema.safeParse(value).success).toBe(false)
    }
    const append = { operation: 'append', commandId: 'append-command', artifactId: 'handle', offset: 0, contentBase64: 'Zg==' }
    expect(WorkerNativeOutputCommandSchema.parse(append)).toEqual(append)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...append, offset: -1 }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...append, offset: 0.5 }).success).toBe(false)
  })
  it('publishes only a host handle with display metadata; scope comes from admitted host context', () => {
    const publication = { commandId: create.commandId, filename: create.filename, mediaType: create.mediaType, artifactId: 'host-handle' }
    const command = { operation: 'publish', publication }
    expect(WorkerNativeOutputCommandSchema.parse(command)).toEqual(command)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...command, publication: { ...publication, scope: { kind: 'temporary' } } }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...publication, operation: 'publish' }).success).toBe(false)
  })
  it('maps mutation and publication to existing file permissions without expanding relay lease authorization', () => {
    expect(WORKER_NATIVE_OUTPUT_FILE_OPERATIONS).toEqual({ create: 'files.write_working_copy', append: 'files.write_working_copy', seal: 'files.write_working_copy', publish: 'files.publish_result' })
    expect(WorkerMcpRelayRequestSchema.options.map(schema => schema.shape.operation.value)).toContain('worker-mcp.authorize-native-output')
  })
})
