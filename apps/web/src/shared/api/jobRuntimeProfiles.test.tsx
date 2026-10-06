import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { server } from '../../mocks/server'
import { useJobRuntimeProfiles } from './jobRuntimeProfiles'
const clients:QueryClient[]=[]
function wrapper(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);return function Wrapper({children}:{children:ReactNode}){return <QueryClientProvider client={client}>{children}</QueryClientProvider>}}
afterEach(()=>{cleanup();for(const client of clients.splice(0))client.clear()})
const base=`/api/management/workspaces/${profile.workspaceId}/jobs`
describe('runtime profile browser client',()=>{
  it('reads persisted verification resources and runtime setup status without starting qualification', async () => {
    let reads = 0
    server.use(http.get(`${base}/runtime-profiles`, () => {
      reads++
      return HttpResponse.json({ profiles: [{ profile: verificationProfile, ready: false,
        reasons: ['runtime_configuration_changed'], sideEffects: false }], approvals: [] })
    }))
    const read = renderHook(() => useJobRuntimeProfiles(profile.workspaceId), { wrapper: wrapper() })
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true))
    expect(read.result.current.data?.profiles[0]).toEqual({ profile: verificationProfile, ready: false,
      reasons: ['runtime_configuration_changed'], sideEffects: false })
    expect(reads).toBe(1)
  })
  it('reads exact scoped captured fingerprints through HTTP',async()=>{
    server.use(http.get(`${base}/runtime-profiles`,()=>HttpResponse.json({profiles:[{profile,ready:false,reasons:['RUNTIME_UNQUALIFIED'],sideEffects:false}],approvals:[approval]})))
    const read=renderHook(()=>useJobRuntimeProfiles(profile.workspaceId),{wrapper:wrapper()})
    await waitFor(()=>expect(read.result.current.isSuccess).toBe(true))
    expect(read.result.current.data?.approvals).toEqual([approval])
  })
})
