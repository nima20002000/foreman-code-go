import { expect, test } from '@playwright/test'

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 900 },
]

async function sidebarLayout(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.shell-navigation')
    const aside = document.querySelector('aside.shell-sidebar')
    if (!nav || !aside) throw new Error('sidebar not found')
    const asideBox = aside.getBoundingClientRect()
    const contentRight = asideBox.right - parseFloat(getComputedStyle(aside).paddingRight)
    const clipped = [...aside.querySelectorAll('button, a')]
      .filter((element) => !element.classList.contains('sidebar-collapse-button'))
      .filter((element) => element.getBoundingClientRect().right > contentRight + 0.5)
      .map((element) => (element.textContent ?? '').trim())
    return {
      horizontalOverflow: nav.scrollWidth - nav.clientWidth,
      clipped,
    }
  })
}

for (const viewport of viewports) {
  test(`keeps deeply expanded sidebar controls inside the rail at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/workspaces/workspace-1')
    await expect(page.getByTestId('workflow-navigation')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Research to review' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New workflow' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New workspace' })).toBeVisible()

    const expanded = await sidebarLayout(page)
    expect(expanded.clipped).toEqual([])
    expect(expanded.horizontalOverflow).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Collapse navigation' }).click()
    await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible()
    await expect
      .poll(async () => (await page.locator('aside.shell-sidebar').boundingBox())?.width)
      .toBeLessThanOrEqual(64)

    const collapsed = await sidebarLayout(page)
    expect(collapsed.clipped).toEqual([])
    expect(collapsed.horizontalOverflow).toBeLessThanOrEqual(1)
  })

  test(`keeps the graph add control clear of the sidebar at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/workspaces/workspace-1')
    await expect(page.getByRole('button', { name: 'Add agent to graph' })).toBeVisible()

    const gap = await page.evaluate(() => {
      const add = document.querySelector('.workflow-graph-add-agent')
      const collapse = document.querySelector('.sidebar-collapse-button')
      const aside = document.querySelector('aside.shell-sidebar')
      if (!add || !collapse || !aside) throw new Error('controls not found')
      const addBox = add.getBoundingClientRect()
      const collapseBox = collapse.getBoundingClientRect()
      const asideBox = aside.getBoundingClientRect()
      return addBox.left - Math.max(collapseBox.right, asideBox.right)
    })

    expect(gap).toBeGreaterThanOrEqual(12)
  })
}
