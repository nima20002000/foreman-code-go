import type { Client } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { RunExecutionsPageSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import type { CrossComputerCiInput } from './crossComputerCiInput.js'
import type { RunningCiWorkflow, ScenarioObservation } from './crossComputerCiObservation.js'
import { callCiTool } from './crossComputerCiSetup.js'
import { readCiLog } from './crossComputerCiReadback.js'
import { waitForCi } from './crossComputerCiWait.js'

export function recordScenario(workflows: RunningCiWorkflow[], observation: ScenarioObservation, input: CrossComputerCiInput) {
  return {
    workflows: workflows.map(workflow => ({ workspaceId: workflow.workspace.workspaceId,
      workflowId: workflow.graph.id, workflowVersionId: workflow.saved.version.id, runId: workflow.runId,
      project: workflow.workspace.project, repository: workflow.repository,
      assignments: workflow.assignments.map(agent => ({ agentId: agent.agentId, nodeId: agent.nodeId,
        suite: agent.suite, ...(agent.task ? { task: agent.task } : {}), hostRef: agent.profile.target.hostRef })) })),
    workspaces: input.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, ciComputers: workspace.ciComputers })),
    tickets: [...observation.tickets.values()], groups: Object.fromEntries(observation.groups),
    reports: Object.fromEntries(observation.reports), runs: [...observation.runs.values()],
    agentStates: Object.fromEntries(observation.agentStates),
    activities: Object.fromEntries([...observation.activities].map(([runId, items]) => [runId, [...items.values()]])),
    activityPages: Object.fromEntries(observation.activityPages), ciLists: Object.fromEntries(observation.ciLists),
    executions: Object.fromEntries(observation.executions), placements: Object.fromEntries(observation.placements),
    groupLogs: Object.fromEntries(observation.groupLogs), isolation: observation.isolation,
    exclusions: observation.exclusions, readErrors: observation.readErrors,
  }
}
export type RecordedScenario = ReturnType<typeof recordScenario>

export async function collectCiReadback(client: Client, workflows: RunningCiWorkflow[],
  observation: ScenarioObservation, input: CrossComputerCiInput) {
  const deadline = Date.now() + 120_000
  const collect = async (label: string, read: () => Promise<void>) => {
    try { await read() } catch (error) {
      observation.readErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const workflow of workflows) {
    const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
    let details = observation.runs.get(workflow.runId)
    await collect(`Run ${workflow.runId} details`, async () => {
      details = await waitForCi('run worktree publication', async () => {
        const value = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
        observation.runs.set(workflow.runId, value)
        return value
      }, value => value.executions.filter(execution => execution.result?.outcome === 'succeeded')
        .every(execution => value.worktrees?.some(tree => tree.executionId === execution.id && tree.branch)),
      { deadline })
    })
    await collect(`Run ${workflow.runId} worktrees`, async () => {
      await waitForCi('execution worktree publication', async () => {
        const pages = []
        let cursor: string | null = null
        do {
          const page = RunExecutionsPageSchema.parse(await callCiTool(client, 'run_executions_list', {
            ...scope, limit: 100, ...(cursor ? { cursor } : {}),
          }))
          pages.push(page)
          cursor = page.pageInfo.nextCursor
          if (pages.length > 100) throw new Error('Execution pagination budget exceeded.')
        } while (cursor)
        observation.executions.set(workflow.runId, pages)
        return pages.flatMap(page => page.items)
      }, items => (details?.executions ?? []).filter(execution => execution.result?.outcome === 'succeeded')
        .every(execution => items.some(item => item.executionId === execution.id && item.worktree?.branch)),
      { deadline })
    })
    for (const assignment of workflow.assignments) {
      const execution = details?.executions.find(value => value.agentId === assignment.agentId
        && value.result?.outcome === 'succeeded')
      if (!execution) continue
      await collect(`Agent ${assignment.agentId} placement`, async () => {
        await waitForCi('accepted placement publication', async () => {
          const placement = RunPlacementGetResultSchema.parse(await callCiTool(client, 'run_node_placement_get', {
            ...scope, workflowId: workflow.graph.id, nodeId: assignment.nodeId,
          }))
          observation.placements.set(execution.id, placement)
          return placement
        }, value => value.readback.evidence === 'accepted', { deadline })
      })
    }
    const foreign = workflows.find(value => value.workspace.workspaceId !== scope.workspaceId)
    if (foreign) {
      const reads: { name: string; arguments: Record<string, unknown> }[] = [{ name: 'run_get', arguments: { workspaceId: foreign.workspace.workspaceId, runId: workflow.runId } }]
      for (const ticket of observation.tickets.values()) {
        if (ticket.runId !== workflow.runId) continue
        for (const name of ['ci_get', 'ci_logs_read']) {
          reads.push({ name, arguments: { workspaceId: foreign.workspace.workspaceId, ticketId: ticket.ticketId } })
        }
      }
      for (const request of reads) {
        await collect(`${request.name} isolation`, async () => {
          const result = await client.callTool(request, { timeout: 30_000 })
          observation.isolation.push({ tool: request.name, isError: result.isError === true, body: decodeMcpToolResult(result) })
        })
      }
    }
  }
  for (const [groupId, group] of observation.groups) {
    await collect(`Group ${groupId} logs`, async () => {
      await waitForCi('group log publication', async () => {
        const logs = CiLogsOutputSchema.parse(await callCiTool(client, 'ci_logs_read', {
          workspaceId: group.run.workspaceId, ticketId: group.run.id, group: true, maxBytes: 65_536,
        }))
        observation.groupLogs.set(groupId, logs)
        return logs
      }, logs => logs.parts?.length === (group.partitions ?? [group.run]).length,
      { deadline })
    })
  }
  for (const ticket of observation.tickets.values()) {
    await collect(`Ticket ${ticket.ticketId} log publication`, async () => {
      await waitForCi('complete ticket log publication', async () => {
        ticket.log = await readCiLog(client, { workspaceId: ticket.workspaceId, ticketId: ticket.ticketId })
        const readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
          workspaceId: ticket.workspaceId, ticketId: ticket.ticketId,
        }))
        ticket.latest = readback.run
        return ticket
      }, value => Boolean(value.log?.logBytes) && (value.latest.collection !== 'pending'),
      { deadline })
    })
  }
  for (const excluded of input.excludedComputers) {
    await collect('Excluded computer inventory', async () => {
      const listed = CiComputersOutputSchema.parse(await callCiTool(client, 'ci_computers_list', {
        workspaceId: excluded.workspaceId,
      }))
      const computer = listed.computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(excluded.hostRef))
      observation.exclusions.push({ workspaceId: excluded.workspaceId, hostRef: excluded.hostRef,
        ready: computer?.ready ?? false, reasons: computer?.reasons ?? ['Not advertised as a CI computer.'] })
    })
  }
}
