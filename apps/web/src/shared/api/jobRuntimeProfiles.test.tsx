import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { server } from '../../mocks/server'
import { useApproveJobRuntime, useJobRuntimeProfiles } from './jobRuntimeProfiles'
const clients:QueryClient[]=[]
function wrapper(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);return function Wrapper({children}:{children:ReactNode}){return <QueryClientProvider client={client}>{children}</QueryClientProvider>}}
afterEach(()=>{cleanup();for(const client of clients.splice(0))client.clear()})
const base=`/api/management/workspaces/${profile.workspaceId}/jobs`
describe('runtime profile browser client',()=>{
  it('reads persisted verification resources and pending owner review without starting qualification', async () => {
    let reads = 0
    server.use(http.get(`${base}/runtime-profiles`, () => {
      reads++
      return HttpResponse.json({ profiles: [{ profile: verificationProfile, ready: false,
        reasons: ['approval_review_required'], sideEffects: false }], approvals: [] })
    }))
    const read = renderHook(() => useJobRuntimeProfiles(profile.workspaceId), { wrapper: wrapper() })
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true))
    expect(read.result.current.data?.profiles[0]).toEqual({ profile: verificationProfile, ready: false,
      reasons: ['approval_review_required'], sideEffects: false })
    expect(reads).toBe(1)
  })
  it('reads exact scoped pending fingerprints through HTTP',async()=>{
    server.use(http.get(`${base}/runtime-profiles`,()=>HttpResponse.json({profiles:[{profile,ready:false,reasons:['RUNTIME_UNQUALIFIED'],sideEffects:false}],approvals:[approval]})))
    const read=renderHook(()=>useJobRuntimeProfiles(profile.workspaceId),{wrapper:wrapper()})
    await waitFor(()=>expect(read.result.current.isSuccess).toBe(true))
    expect(read.result.current.data?.approvals).toEqual([approval])
  })
  it('posts only a command ID with browser credentials and reads persisted approval',async()=>{
    let persisted=approval,reads=0
    server.use(http.get(`${base}/runtime-profiles`,()=>{reads++;return HttpResponse.json({profiles:[{profile,ready:false,reasons:[],sideEffects:false}],approvals:[persisted]})}),
      http.post(`${base}/runtime-qualifications/${approval.id}/approve`,async({request})=>{
        expect(request.credentials).toBe('same-origin');expect(await request.json()).toEqual({commandId:'stable-approval-command'})
        persisted={...approval,status:'approved',approvedByPrincipalId:'human-fixture',approvedAt:new Date().toISOString()}
        return HttpResponse.json({approval:persisted})
      }))
    const hooks=renderHook(()=>({read:useJobRuntimeProfiles(profile.workspaceId),mutation:useApproveJobRuntime(profile.workspaceId)}),{wrapper:wrapper()})
    await waitFor(()=>expect(hooks.result.current.read.isSuccess).toBe(true))
    await act(async()=>{await hooks.result.current.mutation.mutateAsync({approval,commandId:'stable-approval-command'})})
    await waitFor(()=>expect(hooks.result.current.read.data?.approvals[0]?.status).toBe('approved'))
    expect(reads).toBeGreaterThan(1)
  })
  it('rejects a returned fingerprint from another approval',async()=>{
    server.use(http.post(`${base}/runtime-qualifications/${approval.id}/approve`,()=>HttpResponse.json({approval:{...approval,status:'approved',fingerprintDigest:'2'.repeat(64)}})))
    const mutation=renderHook(()=>useApproveJobRuntime(profile.workspaceId),{wrapper:wrapper()})
    await act(async()=>{await expect(mutation.result.current.mutateAsync({approval,commandId:'stable-approval-command'})).rejects.toThrow('exact runtime fingerprint')})
    expect(mutation.result.current.data).toBeUndefined()
  })
  it('shows a real denied browser response without claiming approval',async()=>{
    server.use(http.post(`${base}/runtime-qualifications/${approval.id}/approve`,()=>HttpResponse.json({error:{code:'AUTH_DENIED',message:'A verified browser session is required.',requestId:'request-denied'}},{status:403})))
    const mutation=renderHook(()=>useApproveJobRuntime(profile.workspaceId),{wrapper:wrapper()})
    await act(async()=>{await expect(mutation.result.current.mutateAsync({approval,commandId:'stable-approval-command'})).rejects.toThrow('verified browser session')})
    expect(mutation.result.current.data).toBeUndefined()
  })
})
