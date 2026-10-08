import { useInfiniteQuery } from '@tanstack/react-query'
import type { JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import type { RepeatGraphScopeV3, RunExecutionSummary } from '@foreman-code/contracts/wave25'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { Button } from '../../shared/ui/nocturne'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { isRunAccessError, runReadErrorLabel } from '../runs-selector/query'
import { applyCanonicalActivityItems } from '../conversations/agentChat/activityMerge'
import { selectedRunChatApi } from '../conversations/agentChat/selectedRunChatClient'
import { ConversationHistory } from '../conversations/ConversationHistory'
import { ChatMessageFiles } from '../conversations/ChatMessageFiles'
import { OperatorActivityList } from '../operator-chat/OperatorActivityList'
import { jobsClient } from '../jobs/client'
import { JobResult } from '../jobs/JobResult'
import { JobQueueFacts } from '../jobs/JobSpecFacts'
import { readForRunVisit, runNodeInspectionKey, useRunNodeRead } from './inspectionQuery'

export function AgentExecutionResults({ selection, scope, execution, name }: {
  selection: SelectedRunState; scope: RepeatGraphScopeV3;
  execution: Exclude<RunExecutionSummary, { kind: 'job' }>; name: string
}) {
  useHarnessSessionEpoch()
  const origin: JobInitiatingAgent = { workflowId: scope.workflowId, runId: scope.runId,
    agentId: execution.agentId, executionId: execution.executionId }
  const ci = useInfiniteQuery({
    queryKey: [...runNodeInspectionKey(selection), execution.executionId, 'ci'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readForRunVisit(selection, signal, async () => {
      const page = await jobsClient.queuePage(scope.workspaceId,
        { initiatingExecutionId: execution.executionId, historyBeforeSequence: pageParam }, { signal })
      if (page.tickets.some(ticket => !ticket.initiatingAgent
        || ticket.initiatingAgent.workflowId !== origin.workflowId
        || ticket.initiatingAgent.runId !== origin.runId
        || ticket.initiatingAgent.agentId !== origin.agentId
        || ticket.initiatingAgent.executionId !== origin.executionId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'CI history belongs to another Agent execution.' })
      }
      return page
    }),
    getNextPageParam: page => page.nextHistoryCursor ?? undefined,
    enabled: !sessionIsSwitching(),
    retry: false, staleTime: 0, gcTime: 0, maxPages: 5,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
  })
  if (!selection.isCurrent(selection.generation) || sessionIsSwitching()) return null
  const tickets = new Map((ci.data?.pages.flatMap(page => page.tickets) ?? []).map(ticket => [ticket.id, ticket]))
  return <>
    <AgentOutput selection={selection} scope={scope} execution={execution} name={name} />
    <section aria-label="Agent CI results"><h3>CI executions</h3>
      {ci.isError ? <p role="status">CI history unavailable. {runReadErrorLabel(ci.error)}</p> : <>
        {ci.isPending ? <p role="status">Reading CI requests…</p> : null}
        {!ci.isPending && !tickets.size ? <p>No CI requests recorded for this Agent execution.</p> : null}
        {[...tickets.values()].map(ticket => <section key={ticket.id} aria-label={`CI request ${ticket.id}`}>
          <JobQueueFacts ticket={ticket} />
          {ticket.state === 'accepted' ? <JobResult readOnly workspaceId={scope.workspaceId}
            executionId={ticket.executionId} expectedInitiatingAgent={origin}
            expectedDefinitionVersionId={ticket.definition.versionId} /> : null}
        </section>)}
        {ci.hasNextPage ? <Button size="sm" disabled={ci.isFetching}
          onClick={() => void ci.fetchNextPage()}>Load older CI requests</Button> : null}
      </>}
      <Button size="sm" disabled={ci.isFetching} onClick={() => void ci.refetch()}>Refresh CI requests</Button>
    </section>
  </>
}

function AgentOutput({ selection, scope, execution, name }: {
  selection: SelectedRunState; scope: RepeatGraphScopeV3;
  execution: Exclude<RunExecutionSummary, { kind: 'job' }>; name: string
}) {
  const query = useRunNodeRead(selection, [execution.executionId, 'agent-output'], signal => selectedRunChatApi.read({
    workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
    workflowNodeId: execution.workflowNodeId, executionId: execution.executionId,
  }, { signal }))
  const result = query.isError ? undefined : query.data
  const state = result?.kind === 'selected' && result.state.context.agentId === execution.agentId
    ? result.state : undefined
  return <section aria-label="Agent output and artifacts"><h3>Agent output and artifacts</h3>
    {query.isError ? <p role="status">Agent output unavailable. {runReadErrorLabel(query.error)}</p>
      : !state ? <p role="status">{query.isPending ? 'Reading Agent output…' : 'No Agent output available.'}</p> : <>
        <ConversationHistory messages={state.messages.filter(message => message.activityChannel !== 'reasoning')}
          assistantName={name} renderAfter={message => message.attachments?.length
            ? <ChatMessageFiles message={message} workspaceId={scope.workspaceId} /> : null} />
        <OperatorActivityList onBrowse={() => {}} entries={applyCanonicalActivityItems(state.activities, state.activitySnapshot)
          .filter(activity => activity.kind !== 'thinking')} />
        {state.hasEarlierMessages ? <p>Earlier output is available in this Run’s chat history.</p> : null}
      </>}
  </section>
}
