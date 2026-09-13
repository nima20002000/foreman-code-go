import { expect, test } from '@playwright/test'

test.describe('theme preference', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('defaults to dark with no saved preference and exposes an accessible toggle', async ({ page }) => {
    await page.goto('/workspaces/workspace-1')

    await expect.poll(() => page.evaluate(() => localStorage.length)).toBe(0)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()
  })

  test('switches to light, persists across reload, and returns to dark after clearing storage', async ({ page }) => {
    await page.goto('/workspaces/workspace-1')

    const root = page.locator('html')
    const toggle = page.getByRole('button', { name: 'Switch to light theme' })

    await expect(root).toHaveAttribute('data-theme', 'dark')
    await toggle.click()

    await expect(root).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()

    await page.reload()
    await expect(root).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()

    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()
  })
})
