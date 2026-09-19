import { describe, expect, it } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { firstScheduleAt, dueSchedule } from '../src/modules/workflows/triggerTiming.js'
import { codexModelOptions, openCodeOptions, harnessSettingSupport } from '../src/modules/harnesses/operatorOptions.js'
import { operatorToolAvailable } from '../src/mcp/operator/availability.js'
import { OPERATOR_TOOL_ACTIONS } from '../src/mcp/operator/catalog.js'
import { operatorResponseAccess } from '../src/modules/interactions/operator.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import type { DurableInteraction } from '@graphql/contracts'

const owner: ManagementPrincipal = {id:'owner',name:'Owner',audience:'operator',expiresAt:'2099-01-01T00:00:00Z',revokedAt:null,
  grants:[{actions:[...ManagementActionSchema.options],scope:{}}]}
function context(principal = owner): OperatorRequestContext {
  return {principal,services:{settings:{},interactions:{},extensions:{native:{},agents:{},history:{},lifecycle:{},
    workspace:{provisioningEnabled:true},runs:{},skills:{},triggers:{}}}} as unknown as OperatorRequestContext
}

describe('Operator MCP permission boundaries', () => {
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
