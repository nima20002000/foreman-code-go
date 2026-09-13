import { expect, test } from '@playwright/test'

test('loads the workbench shell', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('graphql')
  await expect(page.getByRole('heading', { name: 'graphql' })).toBeVisible()
})

test('loads workspace data through MSW and keeps agent selection in browser history', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  await expect(page.getByTestId('workspace-name')).toHaveText('Website')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Operator' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Researcher agent, Available/ })).toBeVisible()

  await page.getByRole('button', { name: /Researcher agent, Available/ }).click()
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?agentId=agent-researcher$/)
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible()
  await expect(page.getByText(/Researcher brief context is ready/i)).toBeVisible()

  const researcherComposer = page.getByRole('textbox', { name: 'Message' })
  await researcherComposer.fill('Researcher-only draft')

  await page.goBack()
  await expect(page).toHaveURL(/\/workspaces\/workspace-1$/)
  await expect(page.getByRole('heading', { name: 'Operator' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')

  await page.goForward()
  await expect(page).toHaveURL(/agentId=agent-researcher/)
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Researcher-only draft')
})

test('renders waiting-browser facts without conflating the waiting agent and resource holder', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('mock-mode')).toHaveText('normal')

  await page.getByRole('combobox', { name: 'Mock data scenario' }).selectOption('waiting-browser')
  await expect(page.getByTestId('mock-mode')).toHaveText('waiting-browser')
  await expect(page.getByTestId('agent-condition-label')).toHaveText('Available')
  await expect(page.getByRole('button', { name: /Researcher agent, Waiting for browser · GitHub · held by Operator/ })).toBeVisible()

  await page.getByRole('button', { name: /Researcher agent, Waiting for browser · GitHub · held by Operator/ }).click()
  await expect(page.getByTestId('agent-condition-label')).toHaveText('Waiting for browser')
  await expect(page.getByText('Waiting for GitHub. Held by Operator. Execution: Research to review.')).toBeVisible()
  await expect(page.getByText('Local Runner · ready')).toBeVisible()
})

test('exposes scenario-driven empty, error, and stale states without leaking history', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  const scenario = page.getByRole('combobox', { name: 'Mock data scenario' })

  await scenario.selectOption('empty')
  await expect(page.getByTestId('workspace-empty')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Operator' })).toBeVisible()
  await expect(page.getByText(/No conversation history is available/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'History' })).not.toBeVisible()

  await scenario.selectOption('error')
  await expect(page.getByTestId('workspace-error')).toContainText('selected mock scenario fails read requests')

  await scenario.selectOption('normal')
  await page.reload()
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await page.goto('/workspaces/workspace-1?agentId=agent-old')
  await expect(page.getByTestId('agent-context-stale')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'History' })).not.toBeVisible()
})

test('keeps terminal collapsed until explicitly expanded', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  const terminal = page.getByTestId('terminal-placeholder')
  await expect(terminal.getByRole('heading', { name: 'No terminal connected' })).toBeVisible()
  await expect(terminal.getByText(/Connect a runner to open a terminal/i)).not.toBeVisible()

  const expand = terminal.getByRole('button', { name: 'Expand' })
  await expand.focus()
  await expect(expand).toBeFocused()
  await expand.press('Enter')
  await expect(terminal.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true')
  await expect(terminal.getByText(/Connect a runner to open a terminal/i)).toBeVisible()
})
