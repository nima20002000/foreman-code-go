import { expect, test } from '@playwright/test'

test('loads the workbench shell', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('graphql')
  await expect(page.getByRole('heading', { name: 'graphql' })).toBeVisible()
})

test('loads workspace data through MSW and keeps agent selection in browser history', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toBeVisible()
  const researcherNode = page.getByTestId('agent-node-agent-researcher')
  await expect(researcherNode.getByText('Agent')).toBeVisible()
  await expect(researcherNode.getByText('Step 1')).toBeVisible()
  await expect(researcherNode.getByText('Available')).toHaveCount(0)
  await expect(researcherNode.getByText('Finds and summarizes source material.')).toHaveCount(0)
  await expect(page.getByLabel('Workflow overview')).toBeVisible()
  await expect(page.locator('.react-flow__controls')).toHaveCount(0)
  await expect(page.locator('.shell-header')).toHaveCount(0)
  await expect(page.locator('.context-surface')).toHaveCount(0)
  await expect(page.locator('.terminal-surface')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize workspace context panel' })).toHaveCount(0)

  const graphBox = await page.getByTestId('workflow-graph').boundingBox()
  const canvasBox = await page.getByTestId('workflow-graph-canvas').boundingBox()
  const surfaceBox = await page.locator('.graph-surface').boundingBox()
  const sidebarBox = await page.locator('.shell-sidebar').boundingBox()
  expect(graphBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  expect(surfaceBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(Math.abs((surfaceBox?.x ?? 0) - ((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0)))).toBeLessThanOrEqual(1)
  expect(Math.abs((surfaceBox?.height ?? 0) - (viewport?.height ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((graphBox?.x ?? 0) - (surfaceBox?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((graphBox?.width ?? 0) - (surfaceBox?.width ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((graphBox?.height ?? 0) - (surfaceBox?.height ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs(((surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0)) - (viewport?.width ?? 0))).toBeLessThanOrEqual(1)
  const graphBottom = (graphBox?.y ?? 0) + (graphBox?.height ?? 0)
  const canvasBottom = (canvasBox?.y ?? 0) + (canvasBox?.height ?? 0)
  expect(Math.abs(graphBottom - canvasBottom)).toBeLessThanOrEqual(1)
  const graphNodeCount = await page.locator('.workflow-agent-node').count()
  await expect(page.locator('.react-flow__minimap-node')).toHaveCount(graphNodeCount)

  await page.getByRole('button', { name: 'Researcher agent, Step 1' }).click()
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline&agentId=agent-researcher$/)
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.workflow-graph-minimap-node-selected')).toHaveCount(1)
  await expect(page.locator('.shell-header')).toHaveCount(0)
  await expect(page.locator('.context-surface')).toHaveCount(0)
  await expect(page.getByTestId('agent-context-panel')).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline$/)
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toHaveAttribute('aria-pressed', 'false')

  await page.goForward()
  await expect(page).toHaveURL(/agentId=agent-researcher/)
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.shell-header')).toHaveCount(0)
})

test('keeps waiting-browser state in graph data without adding visual node metadata', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('mock-mode')).toHaveText('normal')

  await page.getByRole('combobox', { name: 'Mock data scenario' }).selectOption('waiting-browser')
  await expect(page.getByTestId('mock-mode')).toHaveText('waiting-browser')
  await expect(page.getByTestId('agent-node-agent-researcher')).toHaveAttribute('data-execution-state', 'waiting_browser')
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toBeVisible()

  await page.getByRole('button', { name: 'Researcher agent, Step 1' }).click()
  await expect(page.getByRole('button', { name: 'Researcher agent, Step 1' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.shell-header')).toHaveCount(0)
  await expect(page.locator('.context-surface')).toHaveCount(0)
})

test('clears graph selection from the empty canvas without moving nodes', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  const researcher = page.getByRole('button', { name: 'Researcher agent, Step 1' })
  const researcherNode = page.getByTestId('agent-node-agent-researcher')
  const initialBox = await researcherNode.boundingBox()

  await researcher.click()
  await expect(researcher).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.workflow-graph-minimap-node-selected')).toHaveCount(1)

  await page.locator('.react-flow__pane').click({ position: { x: 80, y: 80 } })

  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline$/)
  await expect(researcher).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.workflow-graph-minimap-node-selected')).toHaveCount(0)
  const finalBox = await researcherNode.boundingBox()
  expect(finalBox?.x).toBe(initialBox?.x)
  expect(finalBox?.y).toBe(initialBox?.y)
})

test('adds a catalog agent to the draft graph through the accessible picker', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('agent-node-agent-researcher')).toBeVisible()
  const initialNodes = await page.locator('.workflow-agent-node').count()
  const add = page.getByRole('button', { name: 'Add agent to graph' })

  await add.click()
  const dialog = page.getByRole('dialog', { name: 'Add agent to graph' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(add).toBeFocused()

  await add.click()
  const keyboardResearcher = page.getByRole('dialog', { name: 'Add agent to graph' }).getByRole('button', { name: /Researcher/ })
  await keyboardResearcher.focus()
  await keyboardResearcher.press('Enter')
  await expect(page.locator('.workflow-agent-node')).toHaveCount(initialNodes + 1)
  await expect(page.locator('.react-flow__minimap-node')).toHaveCount(initialNodes + 1)
  await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.locator('.workflow-agent-node')).toHaveCount(initialNodes)
})

test('exposes scenario-driven empty, error, and stale states without leaking history', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  const scenario = page.getByRole('combobox', { name: 'Mock data scenario' })

  await scenario.selectOption('empty')
  await expect(page.getByTestId('workspace-empty')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'History' })).not.toBeVisible()

  await scenario.selectOption('error')
  await expect(page.getByTestId('workspace-error')).toContainText('selected mock scenario fails read requests')

  await scenario.selectOption('normal')
  await page.reload()
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await page.goto('/workspaces/workspace-1?agentId=agent-old')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'History' })).not.toBeVisible()
})

test('collapses the left navigation to an icon rail and gives the graph the freed space', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  const graph = page.locator('.graph-surface')
  const expandedBox = await graph.boundingBox()
  const collapse = page.getByRole('button', { name: 'Collapse navigation' })
  await collapse.focus()
  await expect(collapse).toBeFocused()
  await collapse.press('Enter')
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'Workspaces' })).toHaveAttribute('title', 'Workspaces')
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/workspaces/workspace-1/agents')
  await expect(page.getByRole('link', { name: 'Terminal' })).toHaveAttribute('href', '/terminal')
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')

  await expect(page.getByLabel('Workflow overview')).toBeVisible()
  expect(expandedBox).not.toBeNull()
  // The rail animates its width, so wait for the transition to settle before
  // comparing geometry.
  await expect.poll(async () => Math.round((await graph.boundingBox())?.x ?? 0)).toBeLessThan(expandedBox?.x ?? 0)
  await expect.poll(async () => Math.round((await graph.boundingBox())?.width ?? 0)).toBeGreaterThan(expandedBox?.width ?? 0)
})

test('nests workspace destinations under an expandable workspaces menu', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  const workspaces = page.getByRole('button', { name: 'Workspaces' })
  await expect(workspaces).toHaveAttribute('aria-expanded', 'true')
  await expect(workspaces).toHaveClass(/nav-item-active/)

  const workspaceEntry = page.getByTestId('workspace-entry-workspace-1')
  const workspaceToggle = page.getByRole('button', { name: 'Collapse Website' })
  await expect(workspaceEntry).toHaveAttribute('aria-current', 'page')
  await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(workspaceEntry).toHaveClass(/nav-item-active/)
  await expect(page.getByRole('button', { name: 'Collapse agents in Website' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: 'Collapse workflows in Website' })).toHaveAttribute('aria-expanded', 'true')

  await expect(page.getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/workspaces/workspace-1/agents')
  await expect(page.getByRole('link', { name: 'Files' })).toHaveAttribute('href', '/workspaces/workspace-1/files')
  await expect(page.getByRole('link', { name: 'Terminal' })).toHaveAttribute('href', '/terminal')
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  await expect(page.getByRole('button', { name: 'New workflow' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New workspace' })).toBeVisible()

  await workspaceToggle.click()
  const expandWorkspace = page.getByRole('button', { name: 'Expand Website' })
  await expect(expandWorkspace).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('link', { name: 'Files' })).toHaveCount(0)
  await expandWorkspace.click()
  await expect(page.getByRole('link', { name: 'Files' })).toBeVisible()

  await workspaces.click()
  await expect(workspaces).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveCount(0)
  await workspaces.click()
  await expect(page.getByRole('link', { name: 'Agents' })).toBeVisible()

  await page.getByRole('link', { name: 'Files' }).click()
  await expect(page).toHaveURL('/workspaces/workspace-1/files')
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
  await expect(page.getByTestId('coming-soon')).toContainText('Coming soon')
  await expect(page.getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page')
  await expect(workspaces).toHaveClass(/nav-item-active/)
})

test('creates a session workspace from the modal', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')

  const trigger = page.getByRole('button', { name: 'New workspace' })
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: 'New workspace' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Create a workspace for its own agents')
  await page.getByRole('textbox', { name: 'Name' }).fill('Scratch')
  await page.getByRole('button', { name: 'Create workspace' }).click()

  await expect(page).toHaveURL(/\/workspaces\/session-/)
  await expect(page.getByTestId('workspace-empty')).toBeVisible()
  await expect(page.locator('[data-testid^="workspace-entry-session-"]')).toHaveText('Scratch')
})

test('keeps graph overlays aligned and collision-free at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 })
  await page.goto('/workspaces/workspace-1')

  const add = page.getByRole('button', { name: 'Add agent to graph' })
  await add.click()
  await page.getByRole('dialog', { name: 'Add agent to graph' }).getByRole('button', { name: /Researcher/ }).click()
  await expect(page.getByLabel('Graph actions')).toBeVisible()

  const addBox = await add.boundingBox()
  const actionsBox = await page.getByLabel('Graph actions').boundingBox()
  const minimapBox = await page.getByLabel('Workflow overview').boundingBox()
  expect(addBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  expect(minimapBox).not.toBeNull()
  expect((addBox?.y ?? 0)).toBeGreaterThan((actionsBox?.y ?? 0) + (actionsBox?.height ?? 0))
  expect((minimapBox?.y ?? 0)).toBeGreaterThan((actionsBox?.y ?? 0) + (actionsBox?.height ?? 0))
  expect((minimapBox?.x ?? 0) + (minimapBox?.width ?? 0)).toBeLessThanOrEqual(620)

  await page.getByRole('button', { name: 'Collapse navigation' }).click()
  await expect(page.getByLabel('Workflow overview')).toBeVisible()
  await expect(page.getByLabel('Graph actions')).toBeVisible()
})
