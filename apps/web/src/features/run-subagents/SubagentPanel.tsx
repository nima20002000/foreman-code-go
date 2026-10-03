import { useMemo } from 'react'
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { createStore, useStore } from 'zustand'
import { SUBAGENT_LIMITS, type RunSubagent, type RunSubagentMessage, type RunSubagentTool, type RunSubagentCommandReceipt } from '@graphql/contracts/subagents'
import { Button, Dialog, Textarea } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { subagentsApi } from './client'
import { subagentsKey, useSubagentDetail, useSubagentMessages, useSubagentTools, type SubagentsScope } from './query'

type CommandVariables = { operation: 'input' | 'interrupt'; commandId: string; expectedRevision: string; text: string }
const providerNames = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
function capabilityLabel(capability: RunSubagent['capabilities']['sendInput'], provider: string, action: string) {
  if (capability.support === 'unsupported') return `${action} not supported by ${provider}.`
  if (capability.support !== 'supported' || capability.qualification !== 'passed') return `${action} not yet qualified for ${provider}.`
  return `${action} unavailable for this session or your access.`
}

export function SubagentPanel({ scope, subagentId, onClose }: { scope: SubagentsScope; subagentId: string; onClose: () => void }) {
  const detail = useSubagentDetail(scope, subagentId)
  const record = detail.isError ? undefined : detail.data
  const child = record?.subagent
  const messages = useSubagentMessages(scope, subagentId, Boolean(child))
  const tools = useSubagentTools(scope, subagentId, Boolean(child))
  const ui = useMemo(() => createStore(() => ({ text: '' })), [])
  const text = useStore(ui, (state) => state.text)
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
  const provider = child ? providerNames[child.provider] : 'provider'
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={child?.name || 'Subagent'}
    size="lg" busy={pending} closeLabel="Close subagent" className="run-subagent-panel">
    {detail.isError ? <p role="alert">Subagent unavailable. <Button onClick={() => void detail.refetch()}>Retry</Button></p>
      : !child ? <p role="status">Loading subagent…</p> : <div className="n-stack">
        <section aria-label="Lifecycle">
          <p><strong>{provider}</strong> · {child.status} · {child.evidence}</p>
          <dl className="run-subagent-lifecycle">
            <dt>First observed</dt><dd>{child.firstObservedAt}</dd>
            {child.startedAt && <><dt>Started</dt><dd>{child.startedAt}</dd></>}
            {child.finishedAt && <><dt>Finished</dt><dd>{child.finishedAt}</dd></>}
            <dt>Last observed</dt><dd>{child.lastObservedAt}</dd>
          </dl>
          {child.evidence !== 'confirmed' && <p role="status">Lifecycle is {child.evidence}; completion is not confirmed.</p>}
          {child.coverage.gaps && <p>Some native evidence is missing.</p>}
        </section>
        <section aria-label="Messages"><h3>Messages</h3>
          <p>Transcript coverage: {messages.data?.pages.at(-1)?.coverage.transcript ?? child.coverage.transcript}.</p>
          {child.capabilities.transcript.support !== 'supported' && <p>{capabilityLabel(child.capabilities.transcript, provider, 'Transcript')}</p>}
          {messages.isError ? <p role="alert">Messages unavailable. <Button onClick={() => void messages.refetch()}>Retry messages</Button></p>
            : messages.isPending ? <p>Loading messages…</p> : <>
              {messages.data?.pages.some((page) => page.coverage.gaps) && <p>Transcript has gaps.</p>}
              {messages.data?.pages.flatMap((page) => page.items).map((item) => <Message key={item.id} item={item} />)}
              {messages.data?.pages.every((page) => page.items.length === 0) && <p>No messages recorded.</p>}
              {messages.hasNextPage && <Button disabled={messages.isFetching} onClick={() => void messages.fetchNextPage()}>Load more messages</Button>}
            </>}
        </section>
        <section aria-label="Tool calls"><h3>Tool calls</h3>
          <p>Tool coverage: {tools.data?.pages.at(-1)?.coverage.tools ?? child.coverage.tools}.</p>
          {child.capabilities.toolCalls.support !== 'supported' && <p>{capabilityLabel(child.capabilities.toolCalls, provider, 'Tool calls')}</p>}
          {child.capabilities.toolResults.support !== 'supported' && <p>{capabilityLabel(child.capabilities.toolResults, provider, 'Tool results')}</p>}
          {tools.isError ? <p role="alert">Tools unavailable. <Button onClick={() => void tools.refetch()}>Retry tools</Button></p>
            : tools.isPending ? <p>Loading tools…</p> : <>
              {tools.data?.pages.some((page) => page.coverage.gaps) && <p>Tool evidence has gaps.</p>}
              {tools.data?.pages.flatMap((page) => page.items).map((item) => <Tool key={item.id} item={item} />)}
              {tools.data?.pages.every((page) => page.items.length === 0) && <p>No tool calls recorded.</p>}
              {tools.hasNextPage && <Button disabled={tools.isFetching} onClick={() => void tools.fetchNextPage()}>Load more tool calls</Button>}
            </>}
        </section>
        <section aria-label="Steering"><h3>Steering</h3>
          {allowed('sendInput') ? <><Textarea label="Message to subagent" value={text} maxLength={SUBAGENT_LIMITS.text}
            disabled={pending || unsettled} onChange={(event) => ui.setState({ text: event.currentTarget.value })} />
            <p>Supported input timing: {child.capabilities.inputTiming}.</p>
            <Button disabled={!text.trim() || pending || unsettled} onClick={() => send('input')}>Send input</Button></>
            : <p>{capabilityLabel(child.capabilities.sendInput, provider, 'Input')}</p>}
          {allowed('interrupt') ? <Button disabled={pending || unsettled} onClick={() => send('interrupt')}>Interrupt subagent</Button>
            : <p>{capabilityLabel(child.capabilities.interrupt, provider, 'Interrupt')}</p>}
          {record?.availableActions.blockedReason && <details><summary>Control availability</summary><p>{record.availableActions.blockedReason}</p></details>}
          {pending && <p role="status">Submitting command…</p>}
          {receipt && <p role="status">Command {receipt.state}{receipt.reasonCode ? `: ${receipt.reasonCode}` : ''}. {receipt.state === 'acknowledged' && 'Native acceptance does not confirm consumption or completion.'}</p>}
          {commandError && <p role="alert">{revisionConflict ? 'Subagent changed. Read the latest revision before sending again.' : 'Command result unavailable. Recheck the same command before sending another.'}</p>}
          {revisionConflict && <Button disabled={detail.isFetching} onClick={async () => { const fresh = await detail.refetch(); if (fresh.isSuccess && lastCommand) { queryClient.getMutationCache().remove(lastCommand.mutation); command.reset() } }}>Use latest revision</Button>}
          {unsettled && !revisionConflict && lastCommand?.variables && <Button disabled={pending} onClick={() => lastCommand?.variables && command.mutate(lastCommand?.variables)}>Recheck command</Button>}
        </section>
      </div>}
  </Dialog>
}
function Message({ item }: { item: RunSubagentMessage }) {
  return <article className="run-subagent-message"><strong>{item.role}</strong><p>{item.text}</p>
    {!item.final && <span>Message in progress</span>}
    {item.truncation.truncated && <p>Message clipped from {item.truncation.originalBytes} bytes.</p>}
  </article>
}
function Tool({ item }: { item: RunSubagentTool }) {
  return <article className="run-subagent-tool"><h4>{item.name} · {item.status}</h4>
    {item.input !== undefined && <details><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
    {item.output !== undefined && <details><summary>Result</summary><pre>{JSON.stringify(item.output, null, 2)}</pre></details>}
    {item.error !== undefined && <details><summary>Error</summary><pre>{JSON.stringify(item.error, null, 2)}</pre></details>}
    {item.truncation.truncated && <p>Tool evidence clipped from {item.truncation.originalBytes} bytes.</p>}
  </article>
}
