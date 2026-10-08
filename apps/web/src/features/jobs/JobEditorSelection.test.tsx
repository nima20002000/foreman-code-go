import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import {
  JobDefinitionSaveRecordSchema,
  type JobAuthoringChoicesRecord,
  type JobDefinitionSaveRecord,
} from '@foreman-code/contracts/job-verification'
import { server } from '../../mocks/server'
import { JobEditor } from './JobEditor'
import { verificationDefinition, verificationTemplate } from './fixtures'

const root = '*/api/management/workspaces/:workspaceId/jobs'
const requirement = { policy: verificationTemplate.policy, limits: verificationTemplate.resources.limits }
const alternative = {
  policy: { ...requirement.policy, executionTimeoutMs: 120000 },
  limits: { ...requirement.limits, cpuLimit: 2, memoryBytes: 134217728 },
}
const otherTemplate = {
  ...verificationTemplate,
  profileId: 'another-profile',
  policy: alternative.policy,
  resources: { ...verificationTemplate.resources, limits: alternative.limits },
}

function mountEditor(initialChoices: Partial<JobAuthoringChoicesRecord> = {}) {
  let choices: JobAuthoringChoicesRecord = {
    targets: [], sources: [], policies: [], autoPolicies: [requirement, alternative],
    verificationTemplates: [verificationTemplate, otherTemplate], ...initialChoices,
  }
  const saved: JobDefinitionSaveRecord[] = []
  server.use(
    http.get(`${root}/choices`, () => HttpResponse.json(choices)),
    http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/definitions`, async ({ request }) => {
      const input = JobDefinitionSaveRecordSchema.parse(await request.json())
      saved.push(input)
      return HttpResponse.json({ definition: { ...verificationDefinition, name: input.name, spec: input.spec } })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>
    <JobEditor workspaceId={verificationDefinition.workspaceId} definition={verificationDefinition} onClose={vi.fn()} />
  </QueryClientProvider>)
  return {
    saved,
    async refresh(next: JobAuthoringChoicesRecord) {
      choices = next
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['jobs', verificationDefinition.workspaceId, 'choices'] })
      })
    },
  }
}

const policySelect = () => screen.getByRole('combobox', { name: 'Required isolation and toolchain policy' })
const templateSelect = () => screen.getByRole('combobox', { name: 'Job template' })
const verificationField = () => screen.getByRole('textbox', { name: 'Verification request (JSON)' })
const saveButton = () => screen.getByRole('button', { name: 'Save job definition' })

it('saves edited verification CPU and memory limits as the Auto placement limits', async () => {
  const { saved } = mountEditor()
  await screen.findByRole('option', { name: /another-profile/ })
  await userEvent.selectOptions(policySelect(), screen.getByRole('option', { name: /1 CPU/ }))
  const verification = { ...verificationDefinition.spec.verification,
    resources: { ...verificationTemplate.resources, limits: alternative.limits } }
  fireEvent.change(verificationField(), { target: { value: JSON.stringify(verification) } })
  expect(saveButton()).toBeEnabled()
  expect(policySelect()).toHaveDisplayValue(/no longer listed/i)
  await userEvent.click(saveButton())
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]?.spec).toMatchObject({ limits: alternative.limits, verification })
})

it('updates the verification reservation when choosing different Auto policy limits', async () => {
  const { saved } = mountEditor()
  await userEvent.selectOptions(policySelect(), await screen.findByRole('option', { name: /2 CPU/ }))
  expect(JSON.parse((verificationField() as HTMLTextAreaElement).value).resources.limits).toEqual(alternative.limits)
  expect(saveButton()).toBeEnabled()
  await userEvent.click(saveButton())
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]?.spec).toMatchObject({ policy: alternative.policy, limits: alternative.limits,
    verification: { resources: { limits: alternative.limits } } })
})

it('explains malformed verification JSON and invalid resource reservations and recovers after correction', async () => {
  mountEditor()
  await screen.findByRole('option', { name: /another-profile/ })
  fireEvent.change(verificationField(), { target: { value: '{' } })
  expect(screen.getByText(/Verification request.*valid JSON/i)).toBeInTheDocument()
  expect(saveButton()).toBeDisabled()
  const verification = { ...verificationDefinition.spec.verification,
    resources: { ...verificationTemplate.resources, limits: { ...requirement.limits, diskBytes: 1 } } }
  fireEvent.change(verificationField(), { target: { value: JSON.stringify(verification) } })
  expect(screen.getByText(/Private storage sub-budgets exceed the Job disk reservation/)).toBeInTheDocument()
  expect(saveButton()).toBeDisabled()
  fireEvent.change(verificationField(), { target: { value: JSON.stringify(verificationDefinition.spec.verification) } })
  expect(screen.queryByText('Configuration needs attention')).not.toBeInTheDocument()
  expect(saveButton()).toBeEnabled()
})

it('restores the active template requirements rather than the original definition', async () => {
  const { saved } = mountEditor()
  const user = userEvent.setup()
  await user.selectOptions(templateSelect(), await screen.findByRole('option', { name: /another-profile/ }))
  await user.selectOptions(policySelect(), screen.getByRole('option', { name: /1 CPU/ }))
  await user.selectOptions(policySelect(), screen.getByRole('option', { name: 'Keep selected template runtime requirements' }))
  expect(saveButton()).toBeEnabled()
  await user.click(saveButton())
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]?.spec).toMatchObject({ policy: otherTemplate.policy, limits: otherTemplate.resources.limits,
    verification: { resources: otherTemplate.resources } })
})

it('keeps the selected template revision and policy through inserted and reordered choices', async () => {
  const { saved, refresh } = mountEditor()
  const user = userEvent.setup()
  await user.selectOptions(templateSelect(), await screen.findByRole('option', { name: /another-profile/ }))
  await user.selectOptions(policySelect(), screen.getByRole('option', { name: /2 CPU/ }))
  const templateValue = (templateSelect() as HTMLSelectElement).value
  const policyValue = (policySelect() as HTMLSelectElement).value
  await refresh({ targets: [], sources: [], policies: [],
    verificationTemplates: [otherTemplate, { ...otherTemplate, profileRevision: 2 }, verificationTemplate],
    autoPolicies: [alternative, requirement,
      { ...requirement, policy: { ...requirement.policy, executionTimeoutMs: 180000 } }] })
  await screen.findByRole('option', { name: /another-profile revision 2/ })
  expect(templateSelect()).toHaveValue(templateValue)
  expect(templateSelect()).toHaveDisplayValue(/another-profile revision 1/)
  expect(policySelect()).toHaveValue(policyValue)
  expect(policySelect()).toHaveDisplayValue(/2 CPU/)
  await user.selectOptions(policySelect(), '')
  await user.click(saveButton())
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]?.spec).toMatchObject({ policy: otherTemplate.policy, limits: otherTemplate.resources.limits })
})

it('explicitly retains selected template and policy pins when their choices disappear', async () => {
  const { saved, refresh } = mountEditor()
  const user = userEvent.setup()
  await user.selectOptions(templateSelect(), await screen.findByRole('option', { name: /another-profile/ }))
  await user.selectOptions(policySelect(), screen.getByRole('option', { name: /2 CPU/ }))
  const templateValue = (templateSelect() as HTMLSelectElement).value
  const policyValue = (policySelect() as HTMLSelectElement).value
  await refresh({ targets: [], sources: [], policies: [],
    verificationTemplates: [verificationTemplate], autoPolicies: [requirement] })
  expect(templateSelect()).toHaveValue(templateValue)
  await waitFor(() => expect(templateSelect()).toHaveDisplayValue(/another-profile.*no longer listed/i))
  expect(policySelect()).toHaveValue(policyValue)
  expect(policySelect()).toHaveDisplayValue(/no longer listed/i)
  await user.selectOptions(policySelect(), '')
  expect(saveButton()).toBeEnabled()
  await user.click(saveButton())
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]?.spec).toMatchObject({ policy: otherTemplate.policy, limits: otherTemplate.resources.limits })
})
