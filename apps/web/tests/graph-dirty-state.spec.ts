import { expect, test } from '@playwright/test'

test('keeps Save graph and Discard absent until a meaningful graph change exists', async ({ page }) => {
  await page.goto('/workspaces/workspace-1')
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Researcher agent, Step 1' }).click()
  await expect(page.getByText(/is the connection source/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open actions for Researcher' }).click()
  await expect(page.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Add agent to graph' }).click()
  await expect(page.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
  await page.getByRole('button', { name: 'Close agent picker' }).click()

  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open actions for Researcher' }).click()
  await page.getByRole('menuitem', { name: 'Unlink' }).click()
  await expect(page.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('button', { name: 'Save graph' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0)
})
