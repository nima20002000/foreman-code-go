import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  Agent,
  GetConversationResponse,
  Message,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'

import {
  queryKeys,
  useAgentQuery,
  useAgentsQuery,
  useConversationQuery,
  useConversationsQuery,
  useUserMessageMutation,
  useWorkspaceDetailsQuery,
} from '../../shared/api/query'
import { ApiError } from '../../shared/api/client'
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState, Surface } from '../../shared/ui/nocturne'
import { AgentIdentity } from '../agents/AgentIdentity'
import {
  ConversationComposer,
  ConversationHistory,
  useConversationDraftStore,
} from '../conversations'

export interface OperatorContextPanelProps {
  workspaceId: string
  /** URL-owned by the parent route; undefined means the stable Operator default. */
  selectedAgentId?: string
  onReturnToOperator?: () => void
}

type Condition = {
  label: string
  detail: string
}

type AgentWithActiveRun = Agent & { activeRunId?: string }

function operatorFromAgents(agents: Agent[]): Agent | undefined {
  return (
    agents.find((agent) => agent.role?.toLowerCase() === 'operator') ??
    agents.find((agent) => agent.name.toLowerCase() === 'operator') ??
    agents.find((agent) => agent.id === 'agent-operator')
  )
}

function currentCondition(agent: Agent, details?: WorkspaceDetailsResponse): Condition {
  const status = agent.executionState ?? agent.status ?? 'available'
  const activeRunId = (agent as AgentWithActiveRun).activeRunId
  const activeRun = activeRunId
    ? details?.runs.find((run) => run.id === activeRunId)
    : undefined
  const browserWait = activeRun?.browserWait ?? undefined
  const runner = agent.harnessSummary?.runnerId
    ? details?.runners?.find((item) => item.id === agent.harnessSummary?.runnerId)
    : undefined

  if (runner?.health.status === 'disconnected' || runner?.health.status === 'offline') {
    return { label: 'Runner disconnected', detail: runner.health.message ?? 'The runner connection is unavailable.' }
  }

  if (browserWait?.reason === 'auth_required') {
    return { label: 'Authentication required', detail: waitDetail('Authentication required', browserWait) }
  }

  if (browserWait) {
    return { label: 'Waiting for browser', detail: waitDetail('Waiting for', browserWait) }
  }

  switch (status) {
    case 'waiting_browser': {
      return { label: 'Waiting for browser', detail: 'A browser resource is required before this can continue.' }
    }
    case 'auth_required':
      return {
        label: 'Authentication required',
        detail: 'Authentication is required before this can continue.',
      }
    case 'interrupted':
      return { label: 'Interrupted', detail: 'This agent was interrupted and has not resumed.' }
    case 'disconnected':
      return { label: 'Runner disconnected', detail: 'The runner connection is unavailable.' }
    case 'working':
      return { label: 'Working', detail: 'This agent is currently working.' }
    default:
      return { label: 'Available', detail: 'This agent is ready for a message.' }
  }
}

function waitDetail(
  prefix: string,
  wait: NonNullable<NonNullable<WorkspaceDetailsResponse['runs'][number]['browserWait']>>,
): string {
  const resource = wait.resourceName ?? wait.resourceId ?? 'the browser resource'
  const holder = wait.holderLabel ?? wait.holderId
  const execution = wait.executionLabel ?? wait.executionId
  const parts = [`${prefix} ${resource}.`]
  if (holder) parts.push(`Held by ${holder}.`)
  if (execution) parts.push(`Execution: ${execution}.`)
  return parts.join(' ')
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

function isNotFound(error: unknown): boolean {
  return ApiError.is(error) && error.status === 404
}

function UnsupportedActions() {
  const actions = ['Run', 'Resume', 'Login', 'Open Browser', 'Files']
  return (
    <div className="n-stack" aria-label="Unavailable actions">
      <Badge tone="neutral">Actions unavailable</Badge>
      <div className="n-actions">
      {actions.map((action) => (
        <Button
          key={action}
          size="sm"
          variant="ghost"
          disabled
          aria-disabled="true"
          title={`${action} is not available.`}
        >
          {action}
        </Button>
      ))}
      </div>
      <p>These controls are shown for context only; no workflow is started.</p>
    </div>
  )
}

function updateMessages(
  current: GetConversationResponse | undefined,
  message: Message,
): GetConversationResponse | undefined {
  if (!current) return current
  return { ...current, messages: [...current.messages, message] }
}

function ContextLoading() {
  return <LoadingState label="Loading agent context…" rows={4} />
}

export function OperatorContextPanel({
  workspaceId,
  selectedAgentId,
  onReturnToOperator,
}: OperatorContextPanelProps) {
  const queryClient = useQueryClient()
  const agentsQuery = useAgentsQuery(workspaceId, {
    enabled: !selectedAgentId,
  })
  const selectedAgentQuery = useAgentQuery(workspaceId, selectedAgentId ?? '', {
    enabled: Boolean(selectedAgentId),
  })
  const conversationsQuery = useConversationsQuery(workspaceId)
  const detailsQuery = useWorkspaceDetailsQuery(workspaceId)

  const agent = selectedAgentId
    ? selectedAgentQuery.data?.agent
    : operatorFromAgents(agentsQuery.data?.agents ?? [])
  const identityLoading = selectedAgentId
    ? selectedAgentQuery.isLoading
    : agentsQuery.isLoading
  const identityError = selectedAgentId ? selectedAgentQuery.error : agentsQuery.error
  const conversation = useMemo(
    () => (agent ? conversationsQuery.data?.conversations.find((item) => item.agentId === agent.id) : undefined),
    [agent, conversationsQuery.data?.conversations],
  )
  const conversationQuery = useConversationQuery(workspaceId, conversation?.id ?? '', {
    enabled: Boolean(conversation),
  })
  const mutation = useUserMessageMutation()
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)

  useEffect(() => {
    mutation.reset()
  }, [conversation?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const condition = agent ? currentCondition(agent, detailsQuery.data) : undefined
  const isStale = Boolean(
    selectedAgentId &&
      !identityLoading &&
      ((!identityError && !agent) || isNotFound(identityError)),
  )

  function sendMessage(content: string) {
    if (!conversation) return
    mutation.mutate(
      { workspaceId, conversationId: conversation.id, content },
      {
        onSuccess: ({ message }, variables) => {
          queryClient.setQueryData<GetConversationResponse>(
            queryKeys.conversation(workspaceId, variables.conversationId),
            (current) => updateMessages(current, message),
          )
          queryClient.setQueryData<{ messages: Message[] }>(
            queryKeys.messages(workspaceId, variables.conversationId),
            (current) => (current ? { messages: [...current.messages, message] } : current),
          )
          clearDraft(variables.conversationId)
        },
      },
    )
  }

  if (identityLoading || conversationsQuery.isLoading) return <ContextLoading />

  if (isStale) {
    return (
      <Surface aria-label="Agent context" data-testid="agent-context-stale" role="status">
        <EmptyState icon="warning" title="Selection is stale" description="The selected agent or its conversation is no longer available in this workspace." action={
          selectedAgentId && onReturnToOperator ? (
          <Button onClick={onReturnToOperator}>Return to Operator</Button>
          ) : undefined
        } />
      </Surface>
    )
  }

  if (identityError || conversationsQuery.error) {
    return (
      <Surface aria-label="Agent context"><ErrorState title="Context unavailable" description={readableError(identityError ?? conversationsQuery.error)} /></Surface>
    )
  }

  if (!agent) {
    return (
      <Surface aria-label="Agent context" data-testid="agent-context-empty"><EmptyState icon="bot" title="No Operator agent" description="This workspace has no stable Operator identity yet." /></Surface>
    )
  }

  if (!conversation) {
    return (
      <Surface aria-label="Agent context" data-testid="agent-context-empty">
        <AgentIdentity agent={agent} />
        <EmptyState icon="history" title="No conversation history" description="No conversation history is available for this agent." />
        <UnsupportedActions />
        {selectedAgentId && onReturnToOperator ? (
          <Button onClick={onReturnToOperator}>Return to Operator</Button>
        ) : null}
      </Surface>
    )
  }

  const messages = conversationQuery.data?.messages ?? []
  const conversationError = conversationQuery.error
  const hasConversationData = Boolean(conversationQuery.data)
  const refreshing = conversationQuery.isFetching && Boolean(conversationQuery.data)

  return (
    <Surface aria-label="Agent context" data-testid="agent-context-panel">
      <AgentIdentity agent={agent} />
      <Card>
        <CardHeader title="Current condition" action={<Badge tone={condition?.label === 'Available' ? 'success' : condition?.label === 'Working' ? 'accent' : 'warning'}><span data-testid="agent-condition-label">{condition?.label}</span></Badge>} />
        <CardBody><p>{condition?.detail}</p>{refreshing ? <p role="status">Refreshing context…</p> : null}</CardBody>
      </Card>

      <Card>
        <CardHeader title="History" />
        <CardBody>
        {conversationError && !hasConversationData ? (
          <Alert live tone="danger" title="Conversation history unavailable">{readableError(conversationError)}</Alert>
        ) : conversationQuery.isLoading ? (
          <LoadingState label="Loading conversation history…" rows={3} />
        ) : (
          <>
            {conversationError ? (
              <Alert live tone="warning" title="Showing stale conversation history">The latest refresh failed.</Alert>
            ) : null}
            <ConversationHistory messages={messages} />
          </>
        )}
        </CardBody>
      </Card>

      {!conversationError || hasConversationData ? (
        <ConversationComposer
          conversationId={conversation.id}
          disabled={conversationQuery.isLoading}
          isSending={mutation.isPending}
          error={mutation.error ? readableError(mutation.error) : undefined}
          onSubmit={sendMessage}
        />
      ) : null}
      <UnsupportedActions />
      {selectedAgentId && onReturnToOperator ? (
        <Button onClick={onReturnToOperator}>Return to Operator</Button>
      ) : null}
    </Surface>
  )
}

/** Alias for route integrations that call the right-hand surface an agent panel. */
export const AgentContextPanel = OperatorContextPanel
/** Short alias for consumers that mount this as the workspace context panel. */
export const ContextPanel = OperatorContextPanel
