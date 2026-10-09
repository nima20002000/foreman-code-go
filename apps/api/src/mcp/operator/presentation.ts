import type {
  CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult, McpServer, ServerContext,
} from '@modelcontextprotocol/server'

type ListHandler = (request: ListToolsRequest, context: ServerContext) => ListToolsResult | Promise<ListToolsResult>
type CallHandler = (request: CallToolRequest, context: ServerContext) => CallToolResult | Promise<CallToolResult>
export type OperatorCatalog = (context: ServerContext) => Promise<ListToolsResult['tools']>

function jsonTextResult(result: CallToolResult): CallToolResult {
  if (result.isError || result.structuredContent === undefined) return result
  const { structuredContent, ...envelope } = result
  const json = JSON.stringify(structuredContent)
  const content = result.content.filter((part) => part.type !== 'text' || part.text !== json)
  return { ...envelope, content: [{ type: 'text', text: json }, ...content] }
}

/** Runs after the SDK validates outputs, and before catalog pagination. */
export function installOperatorPresentation(server: McpServer): OperatorCatalog {
  let list: ListHandler | undefined
  const protocol = server.server
  protocol.setRequestHandler = new Proxy(protocol.setRequestHandler, {
    apply(register, target, arguments_) {
      if (arguments_[0] === 'tools/list') {
        list = arguments_[1] as ListHandler
        const fullList = list
        const handler: ListHandler = async (request, context) => {
          const result = await fullList(request, context)
          return { ...result, tools: result.tools.map(({ outputSchema: _outputSchema, ...tool }) => tool) }
        }
        return Reflect.apply(register, target, ['tools/list', handler])
      }
      if (arguments_[0] === 'tools/call') {
        const call = arguments_[1] as CallHandler
        const handler: CallHandler = async (request, context) => jsonTextResult(await call(request, context))
        return Reflect.apply(register, target, ['tools/call', handler])
      }
      return Reflect.apply(register, target, arguments_)
    },
  })
  return async (context) => {
    if (!list) return []
    return (await list({ method: 'tools/list' }, context)).tools
  }
}
