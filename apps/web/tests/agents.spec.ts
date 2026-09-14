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

  const researcherCard = page.getByRole('button', { name: /Researcher, researcher, Available/ })
  await researcherCard.click()
  await expect(page).toHaveURL(/\/agents\?agentId=agent-researcher$/)
  await expect(researcherCard).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog', { name: 'Researcher' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\/agents$/)
  await expect(researcherCard).toBeFocused()
  await page.goForward()
  await expect(page.getByRole('dialog', { name: 'Researcher' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\/agents$/)

  const developerCard = page.getByRole('button', { name: /Developer, developer, Available/ })
  await developerCard.focus()
  await developerCard.press('Enter')
  await expect(page).toHaveURL(/agentId=agent-developer/)
  await expect(developerCard).toHaveAttribute('aria-pressed', 'true')
  await expect(researcherCard).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('dialog', { name: 'Developer' })).toBeVisible()
  await page.getByRole('button', { name: 'Close agent details' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

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
  await expect(page.getByRole('button', { name: 'Planner, planning, Local session' })).toBeVisible()
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

test('keeps Unlink graph-only and makes Delete an honest session removal', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  const researcherActions = page.getByRole('button', { name: 'Open actions for Researcher' })

  await researcherActions.click()
  const menu = page.getByRole('menu', { name: 'Researcher node actions' })
  await expect(menu.getByRole('menuitem', { name: 'Unlink' })).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Unlink' }).click()
  await expect(menu).toHaveCount(0)
  await expect(researcherActions).toBeFocused()
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(researcherActions).toBeVisible()

  await page.goto('/workspaces/workspace-1/agents')
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible()

  await page.goto('/workspaces/workspace-1')
  await researcherActions.click()
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete Researcher from this session?' })
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(researcherActions).toBeFocused()

  await researcherActions.click()
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
  await confirmation.getByRole('button', { name: 'Delete for this session' }).click()
  await expect(page.getByRole('button', { name: /Researcher agent/ })).toHaveCount(0)
  await expect(page.getByText(/removed for this browser session/)).toBeVisible()

  await page.goto('/workspaces/workspace-1/agents')
  await expect(page.getByRole('heading', { name: 'Researcher' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Developer' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Researcher' })).toHaveCount(0)

  await page.goto('/workspaces/workspace-1')
  await expect(page.getByRole('button', { name: /Researcher agent/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save graph' })).toBeEnabled()
})

test('selecting agent nodes never arms a connection or changes the graph', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  const researcher = page.getByRole('button', { name: 'Researcher agent, Step 1' })
  const developer = page.getByRole('button', { name: 'Developer agent, Step 2' })
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  const initialEdges = await page.locator('.react-flow__edge').count()

  await developer.click()
  await expect(page.getByText(/is the connection source/)).toHaveCount(0)
  await researcher.click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(initialEdges)
  await expect(page).toHaveURL(/agentId=agent-researcher/)
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)

  await page.locator('.react-flow__pane').click({ position: { x: 80, y: 80 } })
  await expect(page.getByText(/is the connection source/)).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline$/)
})

test('resizes a selected graph node within bounds and supports discard and save', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await page.getByRole('button', { name: 'Researcher agent, Step 1' }).click()

  const node = page.locator('.react-flow__node[data-id="node-researcher"]')
  const resizeHandle = node.locator('.workflow-agent-node-resize-handle.bottom.right')
  await expect(resizeHandle).toBeVisible()
  const initial = await node.boundingBox()
  const initialGraphSize = await node.evaluate((element) => ({
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }))
  const handleBox = await resizeHandle.boundingBox()
  expect(initial).not.toBeNull()
  expect(handleBox).not.toBeNull()

  await page.mouse.move((handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2, (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2)
  await page.mouse.down()
  await page.mouse.move((handleBox?.x ?? 0) + 120, (handleBox?.y ?? 0) + 70, { steps: 5 })
  await page.mouse.up()

  const resized = await node.boundingBox()
  const resizedGraphSize = await node.evaluate((element) => ({
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }))
  expect((resized?.width ?? 0)).toBeGreaterThan(initial?.width ?? 0)
  expect((resized?.height ?? 0)).toBeGreaterThan(initial?.height ?? 0)
  expect(resizedGraphSize.width).toBeLessThanOrEqual(520)
  expect(resizedGraphSize.height).toBeLessThanOrEqual(320)
  await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => node.evaluate((element) => Number.parseFloat(element.style.width))).toBe(initialGraphSize.width)
  await expect.poll(() => node.evaluate((element) => Number.parseFloat(element.style.height))).toBe(initialGraphSize.height)

  const restoredHandle = await resizeHandle.boundingBox()
  await page.mouse.move((restoredHandle?.x ?? 0) + (restoredHandle?.width ?? 0) / 2, (restoredHandle?.y ?? 0) + (restoredHandle?.height ?? 0) / 2)
  await page.mouse.down()
  await page.mouse.move((restoredHandle?.x ?? 0) + 80, (restoredHandle?.y ?? 0) + 40, { steps: 4 })
  await page.mouse.up()
  const savedGraphSize = await node.evaluate((element) => ({
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }))
  await page.getByRole('button', { name: 'Save graph' }).click()
  await expect(page.getByText('Graph saved.')).toBeVisible()

  const savedHandle = await resizeHandle.boundingBox()
  await page.mouse.move((savedHandle?.x ?? 0) + (savedHandle?.width ?? 0) / 2, (savedHandle?.y ?? 0) + (savedHandle?.height ?? 0) / 2)
  await page.mouse.down()
  await page.mouse.move((savedHandle?.x ?? 0) + 55, (savedHandle?.y ?? 0) + 35, { steps: 3 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => node.evaluate((element) => Number.parseFloat(element.style.width))).toBe(savedGraphSize.width)
  await expect.poll(() => node.evaluate((element) => Number.parseFloat(element.style.height))).toBe(savedGraphSize.height)
})
