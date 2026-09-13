import { expect, test } from '@playwright/test'

test('navigates to the agents directory and adds an honest session-only agent', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await page.getByRole('button', { name: 'Collapse navigation' }).click()
  await page.getByRole('link', { name: 'Agents' }).click()

  await expect(page).toHaveURL('/workspaces/workspace-1/agents')
  await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute('data-collapsed', 'true')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Developer' })).toBeVisible()

  await page.getByRole('button', { name: 'Add agent' }).click()
  const name = page.getByRole('textbox', { name: 'Name' })
  await expect(name).toBeFocused()
  await page.getByRole('button', { name: 'Add local agent' }).click()
  await expect(page.getByRole('alert')).toHaveText('Name is required.')

  await name.fill('Planner')
  await page.getByRole('textbox', { name: /Role/ }).fill('planning')
  await page.getByRole('textbox', { name: /Description/ }).fill('Creates implementation plans.')
  await page.getByRole('button', { name: 'Add local agent' }).click()

  await expect(page.getByRole('heading', { name: 'Planner' })).toBeVisible()
  await expect(page.getByText('Local session')).toBeVisible()
  await expect(page.getByText('Not connected')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Planner' })).toBeVisible()
})

test('keeps the rail on honest coming-soon routes and supports deep links', async ({ page }) => {
  await page.goto('/workspaces/workspace-1/terminal')

  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
  await expect(page.getByText('Coming soon')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible()
})

test('places Browsers inside Settings with an honest coming-soon detail', async ({ page }) => {
  await page.goto('/workspaces/workspace-1/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.getByRole('link', { name: /Browsers/ }).click()

  await expect(page).toHaveURL('/workspaces/workspace-1/browsers')
  await expect(page.getByRole('link', { name: /Browsers/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Browsers' })).toBeVisible()
  await expect(page.getByText('Browser profile management is planned, but no browser capability is connected in Phase 1.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
})

test('keeps the agents cards usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 })
  await page.goto('/workspaces/workspace-1/agents')

  await expect(page.getByTestId('agents-directory')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible()
  const directoryBox = await page.getByTestId('agents-directory').boundingBox()
  const viewport = page.viewportSize()
  expect(directoryBox).not.toBeNull()
  expect((directoryBox?.x ?? 0) + (directoryBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0)
})
