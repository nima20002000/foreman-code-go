import { expect, test, type Page } from '@playwright/test'

const sectionsGroup = 'workspace:workspace-1:sections'
const sectionOrder = [
  'agents',
  'workflows',
  'files',
  'tasks',
  'runs',
]

function section(page: Page, id: string) {
  return page.locator(`[data-reorder-group="${sectionsGroup}"] [data-reorder-id="${id}"]`)
}

async function readSectionOrder(page: Page): Promise<string[]> {
  return page
    .locator(`[data-reorder-group="${sectionsGroup}"] [data-reorder-id]`)
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.reorderId ?? ''),
    )
}

async function dragSection(page: Page, fromId: string, toId: string, offsetY = 4) {
  const fromBox = await section(page, fromId).boundingBox()
  const toBox = await section(page, toId).boundingBox()
  if (!fromBox || !toBox) throw new Error(`Missing drag boxes for ${fromId} -> ${toId}`)

  const fromX = fromBox.x + fromBox.width / 2
  const fromY = fromBox.y + fromBox.height / 2
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(fromX, fromY - 18, { steps: 4 })
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + offsetY, { steps: 12 })
  await page.mouse.up()
}

test('reorders sibling workspace sections by click-hold drag without navigating', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()
  expect(await readSectionOrder(page)).toEqual(sectionOrder)

  await dragSection(page, 'files', 'workflows')

  expect(await readSectionOrder(page)).toEqual([
    'agents',
    'files',
    'workflows',
    'tasks',
    'runs',
  ])
  await expect(page.getByTestId('navigation-reorder-announcement')).toHaveText(
    'Moved Files to position 2 of 5',
  )
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline$/)
})

test('keeps ordinary click navigation, active state, and submenus after a drag', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()

  await dragSection(page, 'runs', 'tasks')

  expect(await readSectionOrder(page)).toEqual([
    'agents',
    'workflows',
    'files',
    'runs',
    'tasks',
  ])

  await page.getByRole('link', { name: 'Files' }).click()
  await expect(page).toHaveURL('/workspaces/workspace-1/files')
  await expect(page.getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('button', { name: 'Collapse agents in Website' }).click()
  await expect(page.getByTestId('agent-navigation')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand agents in Website' }).click()
  await expect(page.getByTestId('agent-navigation')).toBeVisible()

  expect((await readSectionOrder(page)).slice(3, 5)).toEqual(['runs', 'tasks'])
})

test('reorders the focused sibling with the non-visual keyboard mechanism', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByTestId('workflow-graph')).toBeVisible()

  const tasks = page.getByRole('link', { name: 'Tasks' })
  await tasks.focus()
  await tasks.press('Alt+ArrowUp')

  expect(await readSectionOrder(page)).toEqual([
    'agents',
    'workflows',
    'tasks',
    'files',
    'runs',
  ])
  await expect(page.getByTestId('navigation-reorder-announcement')).toHaveText(
    'Moved Tasks to position 3 of 5',
  )
  await expect(page).toHaveURL(/\/workspaces\/workspace-1\?workflowId=workflow-content-pipeline$/)
})
