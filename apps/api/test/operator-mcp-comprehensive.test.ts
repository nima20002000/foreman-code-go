import { describe, expect, it } from 'vitest'
import {
  AgentCreateInputSchema, AgentUpdateInputSchema, GraphDraftOperationSchema,
  InteractionRespondInputSchema, LocationProvisionInputSchema, RunRetryInputSchema,
  WorkflowTriggerUpdateInputSchema, ManagementActionSchema, type ManagementPrincipal,
} from '@graphql/contracts/management'
import { firstScheduleAt, dueSchedule } from '../src/modules/workflows/triggerTiming.js'
import { codexModelOptions, openCodeOptions, harnessSettingSupport } from '../src/modules/harnesses/operatorOptions.js'
import { operatorToolAvailable } from '../src/mcp/operator/availability.js'
import { OPERATOR_TOOL_ACTIONS } from '../src/mcp/operator/catalog.js'
import { operatorResponseAccess } from '../src/modules/interactions/operator.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import type { DurableInteraction } from '@graphql/contracts'

const configuration = {harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'} as const
const commandId = 'comprehensive-command'
const owner: ManagementPrincipal = {id:'owner',name:'Owner',audience:'operator',expiresAt:'2099-01-01T00:00:00Z',revokedAt:null,
  grants:[{actions:[...ManagementActionSchema.options],scope:{}}]}
function context(principal = owner): OperatorRequestContext {
  return {principal,services:{settings:{},interactions:{},extensions:{native:{},agents:{},history:{},lifecycle:{},
    workspace:{provisioningEnabled:true},runs:{},skills:{},triggers:{}}}} as unknown as OperatorRequestContext
}

describe('Operator MCP comprehensive contracts and permission boundaries', () => {
  it('defaults new standalone Agents to coder, not Operator authority', () => {
    const input={workspaceId:'w',agentId:'a',name:'Agent',commandId,configuration}
    expect(AgentCreateInputSchema.parse(input).productRole).toBe('coder')
    expect(AgentCreateInputSchema.safeParse({...input,productRole:'operator'}).success).toBe(false)
  })
  it('does not allow arbitrary native settings or operational state in creation', () => {
    const input={workspaceId:'w',agentId:'a',name:'Agent',commandId,configuration}
    expect(AgentCreateInputSchema.safeParse({...input,activeRunId:'run'}).success).toBe(false)
    expect(AgentCreateInputSchema.safeParse({...input,configuration:{...configuration,unknownFlag:true}}).success).toBe(false)
  })
  it('requires both the metadata revision and current configuration pin for standalone changes', () => {
    const input={workspaceId:'w',agentId:'a',commandId,expectedRevision:0,name:'Changed'}
    expect(AgentUpdateInputSchema.safeParse(input).success).toBe(false)
    expect(AgentUpdateInputSchema.safeParse({...input,expectedConfigurationVersionId:'v1'}).success).toBe(true)
    expect(AgentUpdateInputSchema.safeParse({workspaceId:'w',agentId:'a',commandId,expectedRevision:0,expectedConfigurationVersionId:'v1'}).success).toBe(false)
  })
  it('preserves template configuration overrides and rejects conflicting product-role declarations', () => {
    const input={type:'agent.add_from_template',agentId:'a',nodeId:'n',name:'Agent',template:'coder',configuration}
    expect(GraphDraftOperationSchema.parse(input)).toMatchObject({configuration})
    expect(GraphDraftOperationSchema.safeParse({...input,productRole:'orchestrator'}).success).toBe(false)
  })
  it('requires source pins when attaching an existing Agent', () => {
    const input={type:'agent.attach',agentId:'a',nodeId:'n'}
    expect(GraphDraftOperationSchema.safeParse(input).success).toBe(false)
    expect(GraphDraftOperationSchema.safeParse({...input,expectedAgentRevision:0,expectedConfigurationVersionId:'v1'}).success).toBe(true)
  })
  it('exposes typed history restore and execution-condition edits', () => {
    expect(GraphDraftOperationSchema.safeParse({type:'workflow.restore_version',versionId:'v1'}).success).toBe(true)
    expect(GraphDraftOperationSchema.safeParse({type:'workflow.set_execution_condition',executionCondition:{kind:'on_event'}}).success).toBe(true)
  })
  it('does not accept arbitrary host paths in controlled provisioning', () => {
    const input={workspaceId:'w',commandId,expectedLocationRevision:0}
    expect(LocationProvisionInputSchema.safeParse(input).success).toBe(true)
    expect(LocationProvisionInputSchema.safeParse({...input,rootPath:'/etc'}).success).toBe(false)
  })
  it('keeps retry and general-question contracts separate from approval semantics', () => {
    expect(RunRetryInputSchema.safeParse({workspaceId:'w',runId:'r',commandId,workflowVersionId:'v1',expectedLocationRevision:0,nodeId:'n'}).success).toBe(false)
    expect(InteractionRespondInputSchema.safeParse({interactionId:'i',commandId,expectedRevision:0,answer:'yes'}).success).toBe(false)
  })
  it('rejects sub-minute schedules and cron-like unimplemented fields', () => {
    const input={workspaceId:'w',workflowId:'f',commandId,expectedRevision:0,workflowVersionId:'v1',expectedLocationRevision:1,enabled:true,
      trigger:{kind:'schedule',startsAt:'2026-09-17T00:00:00Z',intervalSeconds:60}}
    expect(WorkflowTriggerUpdateInputSchema.safeParse(input).success).toBe(true)
    expect(WorkflowTriggerUpdateInputSchema.safeParse({...input,trigger:{...input.trigger,intervalSeconds:59}}).success).toBe(false)
    expect(WorkflowTriggerUpdateInputSchema.safeParse({...input,trigger:{...input.trigger,cron:'* * * * *'}}).success).toBe(false)
  })
  it('does not borrow location permission from another workspace', () => {
    const principal={...owner,grants:[{actions:['runs:start'] as const,scope:{workspaceIds:['a']}},{actions:['workspace_locations:read'] as const,scope:{workspaceIds:['b']}}]}
    const candidate={...owner,grants:principal.grants.map(g=>({...g,actions:[...g.actions]}))}
    expect(operatorToolAvailable(context(candidate),'run_start')).toBe(false)
  })
  it('does not advertise unavailable services or disabled provisioning', () => {
    const c=context()
    delete c.services.extensions
    expect(operatorToolAvailable(c,'agent_create')).toBe(false)
    delete c.services.interactions
    expect(operatorToolAvailable(c,'interaction_summary')).toBe(false)
    delete c.services.settings
    expect(operatorToolAvailable(c,'agent_defaults_get')).toBe(false)
  })
  it('has unique tool names and does not expose Operator self-approval', () => {
    expect(new Set(OPERATOR_TOOL_ACTIONS.map(t=>t.name)).size).toBe(OPERATOR_TOOL_ACTIONS.length)
    expect(OPERATOR_TOOL_ACTIONS.some(t=>t.name.startsWith('operator_chat'))).toBe(false)
  })
  it('does not turn cross-handler visibility into response authority', () => {
    const interaction={id:'i',workspaceId:'w',workflowId:'f',runId:'r',approval:{handler:'user'},status:'pending'} as DurableInteraction
    expect(operatorResponseAccess(owner,interaction)).toEqual({canRespond:false,canRetryDelivery:false,handler:'user'})
  })
})

describe('native discovery and interval scheduling', () => {
  it('filters provider secrets and disconnected models', () => {
    const result=openCodeOptions({connected:['p'],all:[{id:'p',apiKey:'secret',models:{m:{variants:{fast:{}}}}},{id:'offline',models:{x:{}}}]},[{name:'build'}])
    expect(result.models.map(m=>m.id)).toEqual(['p/m'])
    expect(result.models[0]?.variants).toEqual(['','fast'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('reports model-specific Codex effort and tier support', () => {
    expect(codexModelOptions({models:[{slug:'m',supported_reasoning_levels:[{effort:'low'}],additional_speed_tiers:['fast']}]}))
      .toEqual([{id:'m',reasoningEfforts:['low'],variants:[],serviceTiers:['standard','priority']}])
    expect(harnessSettingSupport('opencode').find(v=>v.field==='thinking')?.support).toBe('metadata_only')
  })
  it('does not burst missed schedule intervals', () => {
    const trigger={kind:'schedule',startsAt:'2026-09-17T00:00:00Z',intervalSeconds:60,missed:'skip',input:{}} as const
    const start=Date.parse(trigger.startsAt)
    expect(firstScheduleAt(trigger,start+1)).toBe(start+60_000)
    expect(dueSchedule(trigger,start,start+180_000)).toEqual({fireAt:null,nextAt:start+240_000})
    expect(dueSchedule({...trigger,missed:'latest'},start,start+180_000)).toEqual({fireAt:start+180_000,nextAt:start+240_000})
  })
})
