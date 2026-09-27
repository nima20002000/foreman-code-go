import type { RunNodeActionKind } from '@graphql/contracts'

type ObjectValue = Record<string, unknown>
export const nativeObject = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
export const nativeString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

export interface NativeActionChange {
  id: string
  ended: boolean
  pending: boolean
  kind: RunNodeActionKind
}

/** Agent-role tools on the unified graphql server; every other graphql tool is Operator-only. */
const AGENT_ROLE_TOOLS = new Set(['context_get', 'interaction_list', 'interaction_get', 'interaction_respond'])
function mcpAction(server: string | undefined, tool: string | undefined): RunNodeActionKind {
  // graphql-app/graphql-operator are pre-unification names still found in recorded native history.
  const app = server === 'graphql-app' || server === 'graphql_app'
  const operator = server === 'graphql-operator' || server === 'graphql_operator'
  if (server !== 'graphql' && !app && !operator) return 'using_mcp'
  if (tool === 'interaction_respond') return 'responding_approval'
  if (tool === 'workspace_folder_create') return 'creating_folder'
  return app || (server === 'graphql' && AGENT_ROLE_TOOLS.has(tool ?? '')) ? 'using_app_mcp' : 'using_operator_mcp'
}

/** Uses protocol fields only. Never inspect state.title, commands, paths, arguments, output or model text. */
export function nativeAction(type: string, payload: ObjectValue): NativeActionChange | undefined {
  if (['item.started', 'item.completed', 'item.snapshot'].includes(type)) {
    const item = nativeObject(payload.item)
    const id = nativeString(item.id)
    if (!id) return undefined
    let kind: RunNodeActionKind
    switch (item.type) {
      case 'commandExecution': {
        const actions = Array.isArray(item.commandActions) ? item.commandActions.map(nativeObject) : []
        // Mixed/opaque commands are not falsely presented as a harmless file read.
        const action = actions.length > 0 && actions.every((entry) => entry.type === actions[0]?.type) ? actions[0]?.type : undefined
        kind = action === 'read' ? 'reading_file' : action === 'listFiles' ? 'listing_files'
          : action === 'search' ? 'searching_files' : 'running_command'
        break
      }
      case 'fileChange': kind = 'writing_file'; break
      case 'mcpToolCall': kind = mcpAction(nativeString(item.server), nativeString(item.tool)); break
      case 'collabAgentToolCall': kind = item.tool === 'spawnAgent' ? 'spawning_subagent' : 'using_subagent'; break
      case 'webSearch': kind = 'searching_web'; break
      default: return type === 'item.completed' ? { id, kind: 'running_command', ended: true, pending: false } : undefined
    }
    if (type === 'item.snapshot' && payload.nativeTurnStatus !== 'completed'
      && !['pending', 'inProgress', 'running', 'completed', 'failed', 'declined', 'canceled', 'cancelled', 'interrupted'].includes(String(item.status))) return undefined
    return { id, kind, pending: item.status === 'pending', ended: type === 'item.completed'
      || payload.nativeTurnStatus === 'completed' || Boolean(item.error)
      || ['completed', 'failed', 'declined', 'canceled', 'cancelled', 'interrupted'].includes(String(item.status)) }
  }
  if (type !== 'message.part.updated') return undefined
  const part = nativeObject(payload.part)
  const id = nativeString(part.id)
  if (!id || part.type !== 'tool') return undefined
  const state = nativeObject(part.state)
  const tool = nativeString(part.tool)
  let kind: RunNodeActionKind
  if (tool === 'read') kind = 'reading_file'
  else if (tool === 'grep') kind = 'searching_files'
  else if (tool === 'glob' || tool === 'list') kind = 'listing_files'
  else if (['write', 'edit', 'apply_patch', 'multiedit'].includes(tool ?? '')) kind = 'writing_file'
  else if (tool === 'task') kind = 'spawning_subagent'
  else if (tool === 'bash') kind = 'running_command'
  else if (['websearch', 'webfetch', 'codesearch'].includes(tool ?? '')) kind = 'searching_web'
  else if (tool?.startsWith('graphql-app_') || tool?.startsWith('graphql_app_')) kind = mcpAction('graphql-app', tool.slice('graphql-app_'.length))
  else if (tool?.startsWith('graphql-operator_') || tool?.startsWith('graphql_operator_')) kind = mcpAction('graphql-operator', tool.slice('graphql-operator_'.length))
  else if (tool?.startsWith('graphql_')) kind = mcpAction('graphql', tool.slice('graphql_'.length))
  else return undefined
  if (!['pending', 'running', 'completed', 'error'].includes(String(state.status))) return undefined
  return { id, kind, pending: state.status === 'pending', ended: state.status === 'completed' || state.status === 'error' }
}

const labels: Record<RunNodeActionKind, string> = {
  reading_file: 'Reading file…', writing_file: 'Writing file…', listing_files: 'Listing files…',
  searching_files: 'Searching files…', creating_folder: 'Creating folder…', using_app_mcp: 'Using App MCP…',
  using_operator_mcp: 'Using Operator MCP…', using_mcp: 'Using MCP…', running_command: 'Running command…',
  spawning_subagent: 'Spawning subagent…', using_subagent: 'Using subagent…', searching_web: 'Searching the web…',
  reviewing_request: 'Reviewing request…', responding_approval: 'Responding to approval…',
  waiting_approval: 'Waiting for approval…', waiting_delivery: 'Waiting for approval delivery…',
  waiting_review: 'Waiting to review…', checking_review: 'Checking review state…',
}

/** Names come only from the immutable graph; suspicious/credential-like names use a generic label. */
export function safeNodeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  const unsafeControl = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  })
  if (!name || name.length > 64 || unsafeControl
    || /(?:opm_|sk-|bearer\b|token\b|secret\b|password\b|https?:|[/\\=@])/i.test(name)
    || /[A-Za-z0-9_-]{28,}/.test(name)) return undefined
  return name
}

export function nodeAction(kind: RunNodeActionKind, peerName?: string) {
  const peer = safeNodeName(peerName)
  const label = kind === 'reviewing_request' && peer ? `Reviewing ${peer}’s request…`
    : kind === 'waiting_approval' && peer ? `Waiting for ${peer}’s approval…` : labels[kind]
  return { kind, label }
}
