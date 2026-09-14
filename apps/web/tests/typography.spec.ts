import { expect, test } from '@playwright/test'

async function fontSize(locator: import('@playwright/test').Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).fontSize)
}

test('keeps workspace page titles and section headings on one type scale', async ({ page }) => {
  await page.goto('/workspaces/workspace-1/agents')
  const agentsTitle = page.getByRole('heading', { name: 'Agents', level: 1 })
  await expect(agentsTitle).toBeVisible()
  const pageTitleSize = await fontSize(agentsTitle)
  expect(pageTitleSize).toBe('24px')

  await page.goto('/workspaces/workspace-1/settings')
  const settingsTitle = page.getByRole('heading', { name: 'Settings', level: 1 })
  await expect(settingsTitle).toBeVisible()
  expect(await fontSize(settingsTitle)).toBe(pageTitleSize)

  await page.goto('/workspaces/workspace-1/files')
  const filesTitle = page.getByRole('heading', { name: 'Files', level: 1 })
  await expect(filesTitle).toBeVisible()
  expect(await fontSize(filesTitle)).toBe(pageTitleSize)

  await page.goto('/workspaces/workspace-1/browsers')
  const sectionHeading = page.getByRole('heading', { name: 'Browsers', level: 2 })
  await expect(sectionHeading).toBeVisible()
  expect(await fontSize(sectionHeading)).toBe('18px')
})

test('keeps placeholder and landing text groups on the shared spacing rhythm', async ({ page }) => {
  await page.goto('/')
  const landingLink = page.locator('.shell-card a')
  await expect(landingLink).toBeVisible()
  expect(await landingLink.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
    'underline',
  )

  await page.goto('/workspaces/workspace-1')
  await page.getByRole('combobox', { name: 'Mock data scenario' }).selectOption('empty')
  const placeholder = page.getByTestId('workspace-empty')
  await expect(placeholder).toBeVisible()
  const gaps = await placeholder.evaluate((root) => {
    const [kicker, heading, body] = [...root.children] as HTMLElement[]
    const kickerBox = kicker.getBoundingClientRect()
    const headingBox = heading.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()
    return [
      Math.round(headingBox.top - kickerBox.bottom),
      Math.round(bodyBox.top - headingBox.bottom),
    ]
  })
  expect(gaps).toEqual([4, 8])
})
