import { expect, type Locator, type Page } from '@playwright/test'
import { mainOf, messageContaining, openChat } from '../fixtures.ts'

export * from '../fixtures.ts'

export const mutationGateOf = async (page: Page) => {
  let heldPushes: (() => void)[] | null = null
  await page.routeWebSocket(/.*/, (pageSocket) => {
    const serverSocket = pageSocket.connectToServer()
    pageSocket.onMessage((message) => {
      if (heldPushes && String(message).startsWith('["push"')) heldPushes.push(() => serverSocket.send(message))
      else serverSocket.send(message)
    })
  })
  await page.reload()
  return {
    hold: () => {
      heldPushes = []
    },
    release: () => {
      const pushes = heldPushes ?? []
      heldPushes = null
      for (const send of pushes) send()
    },
  }
}
export const alicesWelcomeMessage = 'Thanks, glad to be here.'
export const quotedTime = '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC'
export const threadToggleName = /^\d+ repl(y|ies)/
export const threadToggleOf = (page: Page) => mainOf(page).getByRole('button', { name: threadToggleName })
export const repliesOf = (page: Page) =>
  mainOf(page).getByRole('list', { name: 'Thread replies' }).getByRole('listitem')
export const replyBoxOf = (page: Page) => mainOf(page).getByRole('textbox', { name: 'Reply' })
export const openMessageMenu = async (message: Locator) => {
  await message.hover()
  await message.getByRole('button', { name: 'Message actions' }).click()
}
export const replyInThread = async (page: Page, text: string) => {
  await openMessageMenu(messageContaining(page, alicesWelcomeMessage).first())
  await page.getByRole('menuitem', { name: 'Reply in thread' }).click()
  await expect(replyBoxOf(page)).toBeFocused()
  await replyBoxOf(page).fill(text)
  await replyBoxOf(page).press('ControlOrMeta+Enter')
  await expect(repliesOf(page).filter({ hasText: text })).toHaveCount(1)
}
export const openWelcome = async (page: Page) => {
  await openChat(page, 'Welcome')
  await expect(messageContaining(page, alicesWelcomeMessage)).toBeVisible()
}
