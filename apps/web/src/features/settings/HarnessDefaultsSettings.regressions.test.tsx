import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { queryKeys } from '../../shared/api/query'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { nativeOptionsFixture } from './settingsExperience.fixtures'
import { ToastProvider } from '../../shared/ui/nocturne'
type SaveDefaults = ReturnType<typeof import('../../shared/api/query').useUpdateManagedHarnessDefaultsMutation>['mutateAsync']
type SaveInput = Parameters<SaveDefaults>[0]
type SaveResponse = Awaited<ReturnType<SaveDefaults>>
const { saveDefaults } = vi.hoisted(() => ({ saveDefaults: vi.fn<SaveDefaults>() }))
vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return { ...actual, useUpdateManagedHarnessDefaultsMutation: () => useMutation({ mutationFn: (input: SaveInput) => saveDefaults(input) }) }
})

vi.mock('../../shared/api/harnessSettings', () => ({
  useNativeHarnessOptions: (harness: 'codex' | 'opencode') => nativeOptionsFixture(harness),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useAutomaticHarnessCheck: () => ({ current: true, result: { isFetching: false, isSuccess: true, isError: false } }),
  useHarnessSessionEpoch: () => 0,
}))
vi.mock('./HarnessDirectoryPicker', () => ({ HarnessDirectoryPicker: () => <div>Folder picker</div> }))

const clients: QueryClient[]=[]
function renderSettings(defaults=DEFAULT_HARNESS_DEFAULTS) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}})
  client.setQueryData(queryKeys.managedHarnessCatalog,(['codex','opencode'] as const).map((harness)=>({harness,defaults:defaults[harness],defaultsRevision:0,capability:null,discoveryError:null})));clients.push(client)
  render(<QueryClientProvider client={client}><ToastProvider><HarnessDefaultsSettings /></ToastProvider></QueryClientProvider>);return client
}
beforeEach(()=>{saveDefaults.mockReset();saveDefaults.mockImplementation(async(input)=>({value:{defaults:input.defaults,revision:1},replayed:false}))})
afterEach(()=>{cleanup();clearRevisionedFormPersistence();for(const client of clients.splice(0))client.clear()})
describe('Harness overview and draft regressions',()=>{
  it.each(['Codex','OpenCode'] as const)('shows %s installation diagnostics only in App connection',async(name)=>{
    renderSettings();const user=userEvent.setup()
    expect(screen.queryByRole('region',{name:`${name} installation`})).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button',{name:`Edit ${name} defaults`}))
    expect(screen.queryByRole('region',{name:`${name} installation`})).not.toBeInTheDocument()
    await user.click(screen.getByRole('button',{name:'App connection'}))
    expect(await screen.findByRole('region',{name:`${name} installation`})).toBeVisible()
    await user.click(screen.getByRole('button',{name:'Model & speed'}))
    expect(screen.queryByRole('region',{name:`${name} installation`})).not.toBeInTheDocument()
  })
  it('preserves newer edits while the selected provider save is pending',async()=>{
    let resolve!:(response:SaveResponse)=>void;const pending=new Promise<SaveResponse>(done=>{resolve=done});saveDefaults.mockImplementationOnce(()=>pending)
    renderSettings();const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Edit Codex defaults'}));await user.click(screen.getByRole('button',{name:'Access & approvals'}))
    const sandbox=screen.getByRole('combobox',{name:'Sandbox'});await user.selectOptions(sandbox,'workspace-write');await user.click(screen.getByRole('button',{name:'Save Codex preset'}))
    await waitFor(()=>expect(saveDefaults).toHaveBeenCalledOnce());await user.selectOptions(sandbox,'read-only')
    const submitted=saveDefaults.mock.calls[0]![0];await act(async()=>{resolve({value:{defaults:submitted.defaults,revision:1},replayed:false});await pending})
    expect(screen.getByText('Earlier changes saved')).toBeVisible();expect(screen.getAllByText('Newer edits are still unsaved.')[0]).toBeVisible();expect(sandbox).toHaveValue('read-only')
  })
  it('does not replace a local provider draft after a server refresh',async()=>{
    const client=renderSettings();const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Edit Codex defaults'}));await user.click(screen.getByRole('button',{name:'Access & approvals'}))
    const sandbox=screen.getByRole('combobox',{name:'Sandbox'});await user.selectOptions(sandbox,'workspace-write')
    act(()=>client.setQueryData(queryKeys.managedHarnessCatalog,(['codex','opencode'] as const).map((harness)=>({harness,defaults:harness==='codex'?{...DEFAULT_HARNESS_DEFAULTS.codex,model:'different-model'}:DEFAULT_HARNESS_DEFAULTS.opencode,defaultsRevision:1,capability:null,discoveryError:null}))))
    expect(sandbox).toHaveValue('workspace-write');await user.click(screen.getByRole('button',{name:'Model & speed'}))
    expect(screen.getByRole('combobox',{name:'Model'})).toHaveValue(DEFAULT_HARNESS_DEFAULTS.codex.model)
  })
  it('shows a saved unsupported native-auto value without silently replacing it',async()=>{
    renderSettings({...DEFAULT_HARNESS_DEFAULTS,opencode:{...DEFAULT_HARNESS_DEFAULTS.opencode,autoApprove:true,advanced:{...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!,permissionHandling:'native_auto'}}})
    const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Edit OpenCode defaults'}));await user.click(screen.getByRole('button',{name:'Access & approvals'}))
    const field=screen.getByRole('combobox',{name:'Permission handling'});expect(field).toHaveValue('native_auto')
    expect(within(field).getByRole('option',{name:'Native automatic handling (unavailable)'})).toBeDisabled()
    await user.selectOptions(field,'graphql_routed');await user.click(screen.getByRole('button',{name:'Save OpenCode preset'}));await waitFor(()=>expect(saveDefaults).toHaveBeenCalledOnce())
    expect(saveDefaults.mock.calls[0]![0].defaults.opencode.autoApprove).toBe(false)
  })
})
