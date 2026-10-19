import { type BrowserContext, expect, type Page } from '@playwright/test'
import {
  connectionsOf,
  inPopup,
  messageItemsOf,
  openChat,
  openMyConnections,
  research,
  sendMessage,
  workingIndicatorOf,
} from '../fixtures.ts'
import { fakeMcpUrl } from '../stack-ports.ts'

export * from '../fixtures.ts'

const toolStep = 'Used whoami (fake)'
export const toolScript = { steps: [{ tool: 'fake-whoami' }], text: 'Checked who I am.' }
export const accountOf = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`
export const logInAtFakeProvider = (context: BrowserContext, account: string) =>
  context.addCookies([{ name: 'fake_mcp_user', value: account, url: fakeMcpUrl }])
export const connectedRowOf = (page: Page) => connectionsOf(page).getByRole('listitem').filter({ hasText: 'fake' })
export const connectFake = async (page: Page, account: string, workspace = 'workspace-acme') => {
  await logInAtFakeProvider(page.context(), account)
  await openMyConnections(page, workspace)
  await inPopup(page, () => connectionsOf(page).getByRole('button', { name: 'Connect fake', exact: true }).click())
  await expect(connectedRowOf(page)).toContainText('Connected')
}
export const promptTool = async (
  page: Page,
  agentScript: (chat: string, script: object) => Promise<void>,
  text: string,
  script: object = toolScript,
) => {
  await agentScript(research, script)
  await openChat(page, 'Research')
  await sendMessage(page, text)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
export const toolStepsOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: toolStep })
export const lastToolResultOf = async (page: Page) => {
  await toolStepsOf(page).last().click()
  return messageItemsOf(page)
    .filter({ has: page.getByRole('button', { name: toolStep, expanded: true }) })
    .last()
}
