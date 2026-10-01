import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { HostHarnessOverride } from '@graphql/contracts/harness-registry'
import { http, HttpResponse } from 'msw'
import { afterEach, it, expect } from 'vitest'
import { server } from '../../mocks/server'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { clearRevisionedFormPersistence } from './revisionedForm'

const mainId = '11111111-1111-4111-8111-111111111111'
const saved: HostHarnessOverride = { instanceId: mainId, revision: 1, instanceRevision: 'pc-r1', target: {
  hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'pc-installation', installationFingerprint: 'pc-fingerprint',
}, presetId: 'codex-default', enabled: true, driverId: 'codex', configuration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'pc-model' }, configurationFingerprint: 'pc-config', qualification: 'unqualified' }
const clients: QueryClient[] = []
afterEach(() => { clearRevisionedFormPersistence(); for (const client of clients.splice(0)) client.clear() })

it('marks malformed host JSON at its editor, prevents saving and clears the error after correction', async () => {
  let saves = 0
  server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [] })),
    http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [saved] })),
    http.post('/api/management/harness-instances/save', () => { saves += 1; return HttpResponse.json({ value: saved, replayed: false }) }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HostHarnessOverrides target={{ hostRef: saved.target.hostRef, applicationInstallationId: mainId }} /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByRole('textbox', { name: 'Model' })
  const shell = screen.getByRole('textbox', { name: 'Shell environment policy · JSON' })
  const original = (shell as HTMLTextAreaElement).value
  await user.clear(shell); await user.paste('{broken')
  await user.click(screen.getByRole('button', { name: 'Save host override' }))
  await waitFor(() => expect(shell).toHaveAttribute('aria-invalid', 'true'))
  expect(shell).toHaveAccessibleDescription(expect.stringContaining('Shell environment must contain valid JSON.'))
  expect(saves).toBe(0)
  await user.clear(shell); await user.paste(original)
  expect(shell).not.toHaveAttribute('aria-invalid', 'true')
  expect(shell).not.toHaveAccessibleDescription(expect.stringContaining('Shell environment must contain valid JSON.'))
})
