import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import {
  AgentFileListInputSchema, AgentFileListResultSchema, AgentFileReadInputSchema, AgentFileReadResultSchema,
  AgentFileCreateWorkingCopyInputSchema, AgentFileCreateWorkingCopyResultSchema,
  AgentFilePublishInputSchema, AgentFilePublishResultSchema,
} from '@graphql/contracts/files'
import { requireLocalRequest } from '../../access/http.js'
import { DomainError } from '../../errors.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { isMutation } from './context.js'
import type { AgentFileToolService } from './service.js'
import { FileTransferError } from './transfers.js'
import { FILE_TOOL_NAMES, type FileToolName } from './types.js'

/** A native facade may wrap these operations without changing any frozen tool schema. */
export type FileMcpService = Pick<AgentFileToolService, 'list' | 'read' | 'createWorkingCopy' | 'publish'> & {
  sessions: Pick<AgentFileToolService['sessions'], 'authenticate'>
  /** Trusted runner annotation only; never a tool input or an immutable source path. */
  workingCopyLocation?(token: string, artifactId: string): Promise<string>
}

export const FILE_TOOLS_MCP_PATH = '/mcp/files'
const bearer = (header: string | undefined) => /^Bearer (gql_file_[A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1]
const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()
const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })

export async function createFileMcpServer(service: FileMcpService, token: string): Promise<McpServer> {
  const caller = await service.sessions.authenticate(token)
  const enabled = new Set<FileToolName>()
  for (const name of FILE_TOOL_NAMES) {
    if (!caller.context.allowedTools.includes(name) || (isMutation(name) && !caller.context.allowMutation)) continue
    try { await service.sessions.authenticate(token, name); enabled.add(name) }
    catch (error) { if (!(error instanceof DomainError) || error.status !== 403) throw error }
  }
  const allowed = (name: FileToolName) => enabled.has(name)
  const server = new McpServer({ name: 'graphql-files', version: '1.0.0' }, { instructions:
    `File-only tools for this authenticated native turn. No workflow GraphQL tools, worker authority, or Operator credentials. `
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
      const publicError = error instanceof ZodError ? new DomainError('INVALID_REQUEST', 'The input does not match the frozen file contract.', 400)
        : error instanceof FileTransferError ? new DomainError(error.code, error.message, 409) : error
      return toolFailure(publicError, 'The file service could not complete the request.')
    }
  }
  if (allowed('files.list')) server.registerTool('files.list', {
    description: 'List a bounded metadata-only manifest for the authenticated conversation. Reference manifests require FIL-37. Scope cannot change the caller context.',
    inputSchema: AgentFileListInputSchema, outputSchema: AgentFileListResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.list(token, input)))
  if (allowed('files.read')) server.registerTool('files.read', {
    description: 'Read at most 64 KiB using exact fileId and revisionId pins. Expired or removed files return unavailable; never substitute a newer revision.',
    inputSchema: AgentFileReadInputSchema, outputSchema: AgentFileReadResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.read(token, input)))
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
  return server
}

/** Separate authenticated surface, not the workflow /mcp server or an Operator credential exchange. */
export function registerFileToolsMcp(app: FastifyInstance, service: FileMcpService): void {
  app.post(FILE_TOOLS_MCP_PATH, { bodyLimit: 64 * 1024 }, async (request, reply) => {
    requireLocalRequest(request)
    const token = bearer(request.headers.authorization)
    await service.sessions.authenticate(token)
    const call = ToolCall.safeParse(request.body)
    if (call.success && FILE_TOOL_NAMES.includes(call.data.params.name as FileToolName)) {
      const name = call.data.params.name as FileToolName
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
      await service.sessions.authenticate(bearer(request.headers.authorization))
      return reply.code(405).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } })
    } })
}
