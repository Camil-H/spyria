import type { Locator, Page, PageScreenshotOptions } from '@playwright/test'
import { expect } from '../e2e/fixtures.ts'

export { openMenu, signedOutScreenOf } from '../e2e/01-access/fixtures.ts'
export { chatRowIn, draftIconOf, looseChatsOf } from '../e2e/02-chats/fixtures.ts'
export * from '../e2e/fixtures.ts'

export const expectLooks = async (
  page: Page,
  target: Page | Locator,
  name: string,
  options: Pick<PageScreenshotOptions, 'mask'> = {},
) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(target).toHaveScreenshot(`${name}-${colorScheme}.png`, options)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
