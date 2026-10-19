import type { Locator, Page } from '@playwright/test'
import { chatLinkOf, sidebarOf } from '../fixtures.ts'

export * from '../fixtures.ts'

export const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
export const chatRowIn = (group: Locator, chatName: string) => group.getByRole('link', { name: chatName })
export const draftIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Has unsent draft' })
