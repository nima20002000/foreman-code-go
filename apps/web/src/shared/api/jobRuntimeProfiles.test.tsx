import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { server } from '../../mocks/server'
import { useComputerPreparation, useJobRuntimeProfiles } from './jobRuntimeProfiles'
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


it('keeps preparation progress when an older idle GET finishes after POST and continues polling', async () => {
  let release!: () => void
  let entered!: () => void
  const enteredRead = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const url = `${base}/runtime-profiles/${verificationProfile.id}/computer-preparation`
  const status = { profileId: verificationProfile.id, deviceId: null, state: 'idle', commit: null,
    stage: null, message: null, profiles: [], startedAt: null, updatedAt: null }
  server.use(
    http.get(url, async () => {
      reads++
      if (reads === 1) { entered(); await held; return HttpResponse.json(status) }
      return HttpResponse.json({ ...status, state: 'preparing', stage: 'packages' })
    }),
    http.post(url, () => HttpResponse.json({ ...status, state: 'preparing', stage: 'packages' })),
  )
  const read = renderHook(() => useComputerPreparation(profile.workspaceId, verificationProfile.id), { wrapper: wrapper() })
  await enteredRead
  await act(() => read.result.current.start.mutateAsync())
  await waitFor(() => expect(read.result.current.status.data?.state).toBe('preparing'))
  release()
  await waitFor(() => expect(read.result.current.status.fetchStatus).toBe('idle'))
  expect(read.result.current.status.data?.state).toBe('preparing')
  await waitFor(() => expect(reads).toBeGreaterThan(1), { timeout: 7000 })
  expect(read.result.current.status.data?.state).toBe('preparing')
}, 10_000)
