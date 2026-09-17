import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDefaultsSettings } from './WorkspaceDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { resetSettingsExperienceFixtures } from '../../shared/mocks/settingsExperienceHandlers'

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }))
const clients: QueryClient[]=[]
beforeEach(resetSettingsExperienceFixtures)
afterEach(()=>{cleanup();clearRevisionedFormPersistence();for(const client of clients.splice(0))client.clear()})
describe('Workspace defaults',()=>{
  it('saves creation suggestions through the shared API without showing a default root grant',async()=>{
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client)
    render(<QueryClientProvider client={client}><WorkspaceDefaultsSettings /></QueryClientProvider>)
    const user=userEvent.setup();const name=await screen.findByRole('textbox',{name:'Suggested workspace name'})
    await user.clear(name);await user.type(name,'New project')
    const description=screen.getByRole('textbox',{name:'Starting description'});await user.type(description,'A shared project workspace.')
    await user.click(screen.getByRole('button',{name:'Save workspace defaults'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Save workspace defaults'})).toBeDisabled())
    expect(name).toHaveValue('New project');expect(description).toHaveValue('A shared project workspace.')
    expect(screen.queryByLabelText(/Root path|Sandbox|Runner/)).not.toBeInTheDocument()
  })
})
