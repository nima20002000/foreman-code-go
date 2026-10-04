import { useMemo, useState } from 'react'
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { createStore, useStore } from 'zustand'
import { SUBAGENT_LIMITS, type RunSubagentMessage, type RunSubagentTool, type RunSubagentCommandReceipt } from '@graphql/contracts/subagents'
import { Button, CodeBlock, Drawer, EmptyState, ErrorState, MessageBubble, Spinner, StatusBadge, Tabs, Textarea, ToolCallCard } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { subagentsApi } from './client'
import { formatBytes, formatClock, providerNames, subagentName, subagentStatus, subagentTiming, toolStatus } from './presentation'
import { subagentsKey, useSubagentDetail, useSubagentMessages, useSubagentTools, type SubagentsScope } from './query'

type CommandVariables = { operation: 'input' | 'interrupt'; commandId: string; expectedRevision: string; text: string }

const coverageNote = (coverage: 'complete' | 'partial' | 'unavailable', what: string, provider: string) =>
  coverage === 'partial' ? `Only part of this subagent's ${what} was captured.`
    : coverage === 'unavailable' ? `${provider} doesn't share this subagent's ${what}.` : undefined

/** Plain-language command outcome. Delivery is not completion: the subagent decides what to do with it. */
function receiptText(receipt: RunSubagentCommandReceipt) {
  const what = receipt.operation === 'run_subagent_interrupt_v1' ? 'Interrupt' : 'Message'
  switch (receipt.state) {
    case 'accepted': case 'dispatching': return `${what} is being sent…`
    case 'acknowledged': return `${what} delivered to the subagent.`
    case 'rejected': return `${what} was not delivered.`
    case 'uncertain': return `${what} delivery isn't confirmed yet.`
  }
}

export function SubagentPanel({ scope, subagentId, onClose }: { scope: SubagentsScope; subagentId: string; onClose: () => void }) {
  const detail = useSubagentDetail(scope, subagentId)
  const record = detail.isError ? undefined : detail.data
  const child = record?.subagent
  const messages = useSubagentMessages(scope, subagentId, Boolean(child))
  const tools = useSubagentTools(scope, subagentId, Boolean(child))
  const ui = useMemo(() => createStore(() => ({ text: '' })), [])
  const text = useStore(ui, (state) => state.text)
  const [tab, setTab] = useState('messages')
  const queryClient = useQueryClient()
  const mutationKey = [...subagentsKey(scope), subagentId, 'command']
  const commands = useMutationState({ filters: { mutationKey, exact: true }, select: (mutation) => ({
    mutation, status: mutation.state.status, error: mutation.state.error,
    variables: mutation.state.variables as CommandVariables | undefined,
    data: mutation.state.data as RunSubagentCommandReceipt | undefined,
  }) })
  // Keep the last command in Query's mutation cache across closing/reopening the panel.
  // A receipt recheck must never allocate a new command ID after uncertainty.
  const lastCommand = commands.at(-1)
  const command = useMutation({ mutationKey, retry: false, gcTime: 60 * 60_000,
    mutationFn: (input: CommandVariables) => {
      const body = { workspaceId: scope.workspaceId, runId: scope.runId, subagentId, commandId: input.commandId, expectedRevision: input.expectedRevision }
      return input.operation === 'input' ? subagentsApi.input({ ...body, text: input.text }) : subagentsApi.interrupt(body)
    },
    onSuccess: (receipt) => {
      if (receipt.state === 'acknowledged') ui.setState({ text: '' })
      void queryClient.invalidateQueries({ queryKey: subagentsKey(scope) })
    },
    onError: () => { void detail.refetch() },
  })
  const pending = lastCommand?.status === 'pending'
  const commandError = lastCommand?.status === 'error'
  const receipt = lastCommand?.data
  const revisionConflict = ApiError.is(lastCommand?.error) && lastCommand.error.code === 'SUBAGENT_REVISION_CONFLICT'
  const unsettled = commandError || Boolean(receipt && ['accepted', 'dispatching', 'uncertain'].includes(receipt.state))
  const allowed = (action: 'sendInput' | 'interrupt') => Boolean(child && record?.availableActions[action]
    && child.capabilities[action].support === 'supported' && child.capabilities[action].qualification === 'passed')
  const send = (operation: 'input' | 'interrupt') => {
    if (!child || !allowed(operation === 'input' ? 'sendInput' : 'interrupt') || pending || unsettled) return
    command.mutate({ operation, commandId: crypto.randomUUID(), expectedRevision: child.revision, text })
  }
  const recheck = () => { if (lastCommand?.variables) command.mutate(lastCommand.variables) }
  const refresh = async () => {
    const fresh = await detail.refetch()
    if (fresh.isSuccess && lastCommand) { queryClient.getMutationCache().remove(lastCommand.mutation); command.reset() }
  }
  const provider = child ? providerNames[child.provider] : 'Provider'
  const status = child ? subagentStatus(child.status) : undefined
  const messageItems = messages.data?.pages.flatMap((page) => page.items) ?? []
  const toolItems = tools.data?.pages.flatMap((page) => page.items) ?? []
  const canSend = allowed('sendInput'), canInterrupt = allowed('interrupt')
  const footer = child && (canSend || canInterrupt || receipt || commandError || pending) ? <div className="run-subagent-steer">
    {canSend && <Textarea label="Message to subagent" value={text} maxLength={SUBAGENT_LIMITS.text} rows={2}
      hint={child.capabilities.inputTiming === 'idle' ? 'Delivered when the subagent is waiting for input.' : undefined}
      disabled={pending || unsettled} onChange={(event) => ui.setState({ text: event.currentTarget.value })}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (text.trim()) send('input') } }} />}
    <div className="run-subagent-steer-actions">
      <div className="run-subagent-steer-status" role="status">
        {pending ? <Spinner label="Sending" />
          : revisionConflict ? <span>The subagent changed since you opened it.</span>
          : commandError ? <span role="alert">Couldn't confirm delivery.</span>
          : receipt ? <span data-state={receipt.state}>{receiptText(receipt)}</span> : null}
      </div>
      {revisionConflict ? <Button size="sm" loading={detail.isFetching} onClick={() => void refresh()}>Refresh</Button>
        : unsettled && lastCommand?.variables ? <Button size="sm" disabled={pending} onClick={recheck}>Check again</Button> : null}
      {canInterrupt && <Button variant="danger" disabled={pending || unsettled} onClick={() => send('interrupt')}>Interrupt</Button>}
      {canSend && <Button variant="primary" disabled={!text.trim() || pending || unsettled} onClick={() => send('input')}>Send</Button>}
    </div>
  </div> : undefined
  return <Drawer open onOpenChange={(open) => { if (!open) onClose() }} title={child ? subagentName(child) : 'Subagent'}
    description={child ? `${provider} subagent` : undefined} size="lg" busy={pending} closeLabel="Close subagent"
    className="run-subagent-panel" footer={footer}>
    {detail.isError ? <ErrorState title="Couldn't load this subagent" description="It may have been removed, or you may no longer have access."
      onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      : !child || !status ? <Spinner label="Loading subagent" /> : <div className="run-subagent-body">
        <section className="run-subagent-summary" aria-label="Status">
          <StatusBadge label={status.label} tone={status.tone} busy={child.status === 'running'} />
          <span>{subagentTiming(child)}</span>
          {child.evidence !== 'confirmed' && <p className="run-subagent-note">This status isn't confirmed yet and may still change.</p>}
          {!canSend && !canInterrupt && <p className="run-subagent-note">View only — {provider} subagents can't be messaged or interrupted from here.</p>}
        </section>
        <Tabs label="Subagent activity" value={tab} onValueChange={setTab} items={[
          { value: 'messages', label: 'Messages', ...(messageItems.length ? { badge: `${messageItems.length}${messages.hasNextPage ? '+' : ''}` } : {}), content: <div className="run-subagent-feed">
            {coverageNote(messages.data?.pages.at(-1)?.coverage.transcript ?? child.coverage.transcript, 'conversation', provider) &&
              <p className="run-subagent-note">{coverageNote(messages.data?.pages.at(-1)?.coverage.transcript ?? child.coverage.transcript, 'conversation', provider)}</p>}
            {messages.isError ? <ErrorState title="Couldn't load messages" description="Try again in a moment." onRetry={() => void messages.refetch()} retrying={messages.isFetching} />
              : messages.isPending ? <Spinner label="Loading messages" /> : <>
                {messageItems.map((item) => <Message key={item.id} item={item} name={subagentName(child)} />)}
                {!messageItems.length && <EmptyState title="No messages yet" description="Messages appear here as the subagent works." icon="chat" />}
                {messages.hasNextPage && <Button size="sm" loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>Load more messages</Button>}
              </>}
          </div> },
          { value: 'tools', label: 'Tool calls', ...(toolItems.length ? { badge: `${toolItems.length}${tools.hasNextPage ? '+' : ''}` } : {}), content: <div className="run-subagent-feed">
            {coverageNote(tools.data?.pages.at(-1)?.coverage.tools ?? child.coverage.tools, 'tool calls', provider) &&
              <p className="run-subagent-note">{coverageNote(tools.data?.pages.at(-1)?.coverage.tools ?? child.coverage.tools, 'tool calls', provider)}</p>}
            {tools.isError ? <ErrorState title="Couldn't load tool calls" description="Try again in a moment." onRetry={() => void tools.refetch()} retrying={tools.isFetching} />
              : tools.isPending ? <Spinner label="Loading tool calls" /> : <>
                {toolItems.map((item) => <Tool key={item.id} item={item} />)}
                {!toolItems.length && <EmptyState title="No tool calls yet" description="Tools the subagent uses appear here." icon="terminal" />}
                {tools.hasNextPage && <Button size="sm" loading={tools.isFetchingNextPage} onClick={() => void tools.fetchNextPage()}>Load more tool calls</Button>}
              </>}
          </div> },
        ]} />
      </div>}
  </Drawer>
}

function Message({ item, name }: { item: RunSubagentMessage; name: string }) {
  return <MessageBubble author={item.role === 'assistant' ? name : 'Parent agent'} role={item.role}
    time={formatClock(item.occurredAt)} dateTime={item.occurredAt} status={!item.final ? <span className="run-subagent-note">writing…</span> : undefined}>
    <p className="run-subagent-text">{item.text}</p>
    {item.truncation.truncated && <p className="run-subagent-note">Shortened — the full message was {formatBytes(item.truncation.originalBytes)}.</p>}
  </MessageBubble>
}

const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
function Tool({ item }: { item: RunSubagentTool }) {
  const status = toolStatus(item.status)
  return <ToolCallCard title={item.name} status={status.label} tone={status.tone}
    summary={item.durationMs !== undefined ? `Took ${(item.durationMs / 1000).toFixed(1)}s` : undefined}>
    {item.input !== undefined && <CodeBlock label="Input" code={json(item.input)} language="json" />}
    {item.output !== undefined && <CodeBlock label="Result" code={json(item.output)} />}
    {item.error !== undefined && <CodeBlock label="Error" code={json(item.error)} />}
    {item.truncation.truncated && <p className="run-subagent-note">Shortened — the full record was {formatBytes(item.truncation.originalBytes)}.</p>}
  </ToolCallCard>
}
