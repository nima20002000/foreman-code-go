import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import {
  AgentFileListInputSchema, AgentFileListResultSchema, AgentFileReadInputSchema, AgentFileReadResultSchema,
  AgentFileCreateWorkingCopyInputSchema, AgentFileCreateWorkingCopyResultSchema,
  AgentFilePublishInputSchema, AgentFilePublishResultSchema, MAX_FILE_WRITE_BYTES,
  AgentFileWriteWorkingCopyInputSchema, AgentFileWriteWorkingCopyResultSchema,
  AgentFileApplyFormatEditInputSchema, AgentFileApplyFormatEditResultSchema,
} from '@foreman-code/contracts/files'
import { requireLocalRequest } from '../../access/http.js'
import { DomainError } from '../../errors.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { isMutation } from './context.js'
import type { AgentFileToolService } from './service.js'
import { FileTransferError } from './transfers.js'
import { ALL_FILE_TOOL_NAMES, type FileToolOperation } from './types.js'

/** A native facade may wrap these operations without changing any frozen tool schema. */
export type FileMcpService = Pick<AgentFileToolService, 'list' | 'read' | 'createWorkingCopy' | 'publish'>
  & Partial<Pick<AgentFileToolService, 'writeWorkingCopy' | 'applyFormatEdit'>> & {
  sessions: Pick<AgentFileToolService['sessions'], 'authenticate'>
    & Partial<Pick<AgentFileToolService['sessions'], 'authenticateSharedEndpoint'>>
  /** Trusted runner annotation only; never a tool input or an immutable source path. */
  workingCopyLocation?(token: string, artifactId: string): Promise<string>
}

export const FILE_TOOLS_MCP_PATH = '/mcp/files'
const openCodeMounts = new WeakMap<FastifyInstance, Map<string, FileMcpService>>()
/** The mounted facade authenticates the exact turn token. No shared-service fallback exists here. */
export function mountOpenCodeFileMcp(app: FastifyInstance, mountId: string, service: FileMcpService): () => void {
  const mounts = openCodeMounts.get(app)
  if (!mounts || mounts.has(mountId)) throw new Error('OpenCode file MCP mount is unavailable or already owned.')
  mounts.set(mountId, service)
  return () => { if (mounts.get(mountId) === service) mounts.delete(mountId) }
}
const bearer = (header: string | undefined) => /^Bearer (gql_file_[A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1]
const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()
const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })

export async function createFileMcpServer(service: FileMcpService, token: string): Promise<McpServer> {
  const caller = await service.sessions.authenticate(token)
  const enabled = new Set<FileToolOperation>()
  for (const name of ALL_FILE_TOOL_NAMES) {
    if (!caller.context.allowedTools.includes(name) || (isMutation(name) && !caller.context.allowMutation)) continue
    try { await service.sessions.authenticate(token, name); enabled.add(name) }
    catch (error) { if (!(error instanceof DomainError) || error.status !== 403) throw error }
  }
  const allowed = (name: FileToolOperation) => enabled.has(name)
  const server = new McpServer({ name: 'graphql-files', version: '1.0.0' }, { instructions:
    `File-only tools for this authenticated native turn. No workflow Foreman Code tools, worker authority, or Operator credentials. `
    + `Scope/destination fields are assertions, not selectors; use ${JSON.stringify(caller.context.scope)}. `
    + 'Permanent references are read-only. Writes require the accepted harness to permit mutation. Publish only completed runner artifact handles.' })
  const invoke = async <T>(operation: () => Promise<T>, describe?: (value: T) => Promise<string | undefined>) => {
    try {
      const value = await operation()
      const result = toolResult(value)
      const detail = await describe?.(value)
      return detail ? { ...result, content: [...result.content, { type: 'text' as const, text: detail }] } : result
    }
    catch (error) {
      const publicError = error instanceof ZodError ? new DomainError('INVALID_REQUEST', 'The input does not match the shared file contract.', 400)
        : error instanceof FileTransferError ? new DomainError(error.code, error.message, 409) : error
      return toolFailure(publicError, 'The file service could not complete the request.')
    }
  }
  if (allowed('files.list')) server.registerTool('files.list', {
    description: 'List a bounded metadata-only manifest for the authenticated conversation. Reference manifests require FIL-37. Scope cannot change the caller context.',
    inputSchema: AgentFileListInputSchema, outputSchema: AgentFileListResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.list(token, input)))
  if (allowed('files.read')) server.registerTool('files.read', {
    description: 'Read at most 64 KiB using exact fileId and revisionId pins. Markdown includes UTF-8 text alongside the base64 bytes. Expired or removed files return unavailable; never substitute a newer revision.',
    inputSchema: AgentFileReadInputSchema, outputSchema: AgentFileReadResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.read(token, input), async (result) => {
    if (result.status !== 'ready' || result.revision.mediaType !== 'text/markdown') return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(Buffer.from(result.contentBase64, 'base64'))
    } catch (error) {
      // A byte range can split a UTF-8 character; its base64 bytes remain available.
      if (error instanceof TypeError) return undefined
      throw error
    }
  }))
  if (allowed('files.create_working_copy')) server.registerTool('files.create_working_copy', {
    description: 'Copy authorized pinned bytes to an isolated runner artifact handle in this authenticated turn. No host path or permanent write target is accepted.',
    inputSchema: AgentFileCreateWorkingCopyInputSchema, outputSchema: AgentFileCreateWorkingCopyResultSchema, annotations: annotations(true),
  }, async (input) => invoke(() => service.createWorkingCopy(token, input), async (result) => {
    const path = await service.workingCopyLocation?.(token, result.value.artifactId)
    return path ? JSON.stringify({ artifactId: result.value.artifactId, path }) : undefined
  }))
  if (allowed('files.publish_result')) server.registerTool('files.publish_result', {
    description: 'Publish a completed artifact as new immutable temporary file/revision IDs in its originating conversation, linked to this turn. commandId is the retry key; changed bytes conflict.',
    inputSchema: AgentFilePublishInputSchema, outputSchema: AgentFilePublishResultSchema, annotations: annotations(true),
  }, async (input) => invoke(() => service.publish(token, input)))
  // Old native facades do not advertise new operations until their safe dispatch is wired.
  if (service.writeWorkingCopy && allowed('files.write_working_copy')) server.registerTool('files.write_working_copy', {
    description: 'Replace all bytes of an owned temporary working-copy handle (at most 25 MiB, canonical base64). Optional baseRevisionId guards the working snapshot, not the source. Never writes project files or permanent references; publish separately.',
    inputSchema: AgentFileWriteWorkingCopyInputSchema, outputSchema: AgentFileWriteWorkingCopyResultSchema,
    annotations: { ...annotations(true), destructiveHint: true, idempotentHint: false },
  }, async (input) => invoke(() => service.writeWorkingCopy!(token, input)))
  if (service.applyFormatEdit && allowed('files.apply_format_edit')) server.registerTool('files.apply_format_edit', {
    description: 'Edit an owned temporary working copy: append_text for Markdown/DOCX/PDF, resize_image, or replace_zip_entry for one existing regular entry. Server derives the format. Use baseRevisionId on retries to avoid applying an edit twice; publish separately. Project permissions do not change.',
    inputSchema: AgentFileApplyFormatEditInputSchema, outputSchema: AgentFileApplyFormatEditResultSchema,
    annotations: { ...annotations(true), destructiveHint: true, idempotentHint: false },
  }, async (input) => invoke(() => service.applyFormatEdit!(token, input)))
  return server
}

/** Separate authenticated surface, not the workflow /mcp server or an Operator credential exchange. */
export function registerFileToolsMcp(app: FastifyInstance, service: FileMcpService): void {
  const mounted = new Map<string, FileMcpService>()
  openCodeMounts.set(app, mounted)
  app.post(`${FILE_TOOLS_MCP_PATH}/opencode/:mountId`, { bodyLimit: 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3) + 512 * 1024,
    onRequest: async (request) => {
      requireLocalRequest(request)
      const selected = mounted.get((request.params as { mountId: string }).mountId)
      if (!selected) throw new DomainError('FILE_SESSION_INVALID', 'The file turn is not mounted.', 401)
      await selected.sessions.authenticate(bearer(request.headers.authorization))
    },
  }, async (request, reply) => {
    requireLocalRequest(request)
    const selected = mounted.get((request.params as { mountId: string }).mountId)
    if (!selected) throw new DomainError('FILE_SESSION_INVALID', 'The file turn is not mounted.', 401)
    const token = bearer(request.headers.authorization)
    await selected.sessions.authenticate(token)
    const server = await createFileMcpServer(selected, token!)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store')
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  // Authenticate before buffering the larger, still bounded base64 request body.
  app.post(FILE_TOOLS_MCP_PATH, { bodyLimit: 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3) + 512 * 1024,
    onRequest: async (request) => {
      requireLocalRequest(request)
      await (service.sessions.authenticateSharedEndpoint ?? service.sessions.authenticate).call(
        service.sessions, bearer(request.headers.authorization))
    },
  }, async (request, reply) => {
    requireLocalRequest(request)
    const token = bearer(request.headers.authorization)
    await (service.sessions.authenticateSharedEndpoint ?? service.sessions.authenticate).call(service.sessions, token)
    const call = ToolCall.safeParse(request.body)
    if (call.success && ALL_FILE_TOOL_NAMES.includes(call.data.params.name as FileToolOperation)) {
      const name = call.data.params.name as FileToolOperation
      try { await service.sessions.authenticate(token, name) }
      catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error
        return reply.send({ jsonrpc: '2.0', id: call.data.id, result: toolFailure(error) })
      }
    }
    const server = await createFileMcpServer(service, token!)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store')
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) app.route({ method, url: FILE_TOOLS_MCP_PATH,
    handler: async (request, reply) => {
      requireLocalRequest(request)
      await (service.sessions.authenticateSharedEndpoint ?? service.sessions.authenticate).call(
        service.sessions, bearer(request.headers.authorization))
      return reply.code(405).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } })
    } })
}
