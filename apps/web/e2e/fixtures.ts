import { type BrowserContext, expect, type Locator, type Page } from '@playwright/test'
import { test, type WorkerStack } from './stack.ts'
import { fakeMcpUrl, serverUrl, viteUrl } from './stack-ports.ts'

export * from '@playwright/test'
export { test } from './stack.ts'
export { serverUrl, ssoDexIssuer, ssoServerUrl, ssoViteUrl } from './stack-ports.ts'

type Machine = {
  id: string
  conversations: { agent: Record<string, unknown>; secrets: object }[]
  prompts: string[]
  modelSwitches: string[]
}
type MachineQuery = { owner?: string; signedIn?: string; online?: string }

export const machineTest = test.extend<{ machine: (query?: MachineQuery) => Promise<Machine> }>({
  machine: async ({ workerStack }, use) => {
    const machine = async (query: MachineQuery = {}) => {
      const search = new URLSearchParams({ db: workerStack.databaseName, ...query })
      return (await (await fetch(`${serverUrl}/test/fake-machine?${search}`, { method: 'POST' })).json()) as Machine
    }
    await use(machine)
    await machine({ online: 'false' })
  },
})

export const agentReplyText = 'Understood, working on it.'
export const research = 'chat-research'
export const blockedNotice = 'Connect an LLM key in your profile to prompt'
export const newSessionNotice = 'The agent started a new session; it does not remember earlier messages'
export const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }

export const delegationsFinished = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(async () =>
      (await workerStack.database.$client`select status from delegations where chat_id = ${chatId}`).map(
        ({ status }) => status,
      ),
    )
    .toEqual(['finished'])
export const sessionStarted = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(
      async () =>
        (await workerStack.database.$client`select agent_conversation_id from runtimes where chat_id = ${chatId}`)[0]
          ?.agent_conversation_id,
    )
    .toBeTruthy()

export const addParticipant = async (workerStack: WorkerStack, chatId: string, memberId: string, roleId: string) => {
  await expect
    .poll(async () => (await workerStack.database.$client`select 1 from chats where id = ${chatId}`).length)
    .toBe(1)
  await workerStack.database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id)
    values ('workspace-acme', ${chatId}, ${memberId}, ${roleId})`
}

export const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
export const mainOf = (page: Page) => page.getByRole('main')
export const switcherOf = (page: Page) => page.getByRole('button', { name: 'Switch workspace' })
export const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
export const sendButtonOf = (page: Page) => page.getByRole('button', { name: 'Send' })
export const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')
export const chatLinkOf = (page: Page, chatName: string) => sidebarOf(page).getByRole('link', { name: chatName })
export const projectGroupOf = (page: Page, projectName: string) =>
  sidebarOf(page).getByRole('group', { name: projectName })
export const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
export const chatRowIn = (group: Locator, chatName: string) => group.getByRole('link', { name: chatName })
export const draftIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Has unsent draft' })
export const unreadIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Unread messages' })

export const messageContaining = (page: Page, text: string | RegExp) => messageItemsOf(page).filter({ hasText: text })
export const workingIndicatorOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
export const foldOf = (page: Page, steps: number) =>
  messageItemsOf(page).getByRole('button', { name: new RegExp(`^Worked for .+ · ${steps} steps$`) })
export const signedOutScreenOf = (page: Page, workspaceName: string) =>
  page.getByText(`You are signed out of ${workspaceName}`)
export const signInButtonOf = (page: Page) => page.getByRole('button', { name: 'Sign in' })
export const signInThroughDex = async (page: Page, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  const popup = await popupOpened
  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#login').fill(email)
  await popup.locator('#password').fill('password')
  await popup.locator('#submit-login').click()
  await popupClosed
}

export const chatAction = async (page: Page, chatName: string, itemName: string) => {
  await page.getByRole('button', { name: `Chat actions for ${chatName}` }).click()
  await page.getByRole('menuitem', { name: itemName }).click()
}
export const projectAction = async (page: Page, projectName: string, itemName: string) => {
  await page.getByRole('button', { name: `Project actions for ${projectName}` }).click()
  await page.getByRole('menuitem', { name: itemName }).click()
}

export const panelOf = (page: Page) => page.getByRole('region', { name: 'Side panel' })
export const panelTabOf = (page: Page, tabName: string) =>
  panelOf(page).getByRole('tablist', { name: 'Panel tabs' }).getByRole('tab', { name: tabName, exact: true })
export const tabPanelOf = (page: Page) => panelOf(page).getByRole('tabpanel')

const roleShownIn = (row: Locator) =>
  row.evaluate((item) => {
    const roleSelect = item.querySelector('select')
    return roleSelect ? roleSelect.selectedOptions[0]?.textContent : item.lastElementChild?.textContent
  })
export const expectMembers = async (page: Page, rolesByName: [string, string][]) => {
  const members = tabPanelOf(page).getByRole('listitem')
  await expect(members).toHaveCount(rolesByName.length)
  for (const [index, [name, role]] of rolesByName.entries()) {
    await expect(members.nth(index)).toContainText(name)
    await expect.poll(() => roleShownIn(members.nth(index))).toBe(role)
  }
}

export const openChat = async (page: Page, chatName: string) => {
  await chatLinkOf(page, chatName).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

export const openPanelTab = async (page: Page, chatName: string, tabName: string) => {
  await openChat(page, chatName)
  await panelTabOf(page, tabName).click()
  await expect(panelTabOf(page, tabName)).toHaveAttribute('aria-selected', 'true')
}

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

export const openProfile = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
}
export const llmSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'LLM access' })
export const machineSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My machine' })
export const machineToolOf = (page: Page, toolName: string) =>
  machineSectionOf(page).getByRole('button', { name: new RegExp(`^(Use ${toolName}|✓ ${toolName} connected)$`) })
export const addCredential = async (page: Page, credential: { provider: string; secret: string }) => {
  await llmSectionOf(page).getByLabel('Provider').fill(credential.provider)
  await llmSectionOf(page).getByLabel('Secret').fill(credential.secret)
  await llmSectionOf(page).getByRole('button', { name: 'Add' }).click()
}
export const addLlmKey = async (page: Page, provider: string, secret = `fake-key-${crypto.randomUUID()}`) => {
  await openProfile(page)
  await addCredential(page, { provider, secret })
  await expect(
    llmSectionOf(page)
      .getByRole('listitem')
      .filter({ hasText: provider })
      .filter({ hasText: `••••${secret.slice(-4)}` }),
  ).toBeVisible()
}

export const openSettings = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
}
export const hostsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Runtime hosts' })
export const urlOf = (command: string) => `${viteUrl}/h/${command.match(/\/h\/([A-Z0-9]{8})\b/)?.[1]}`

export const sendMessage = async (page: Page, text: string) => {
  await composerOf(page).fill(text)
  await composerOf(page).press('ControlOrMeta+Enter')
}

export const runsOnChoiceOf = (page: Page) => mainOf(page).getByRole('group', { name: 'Runs on' })
export const runsOnOf = (page: Page) => mainOf(page).getByRole('combobox', { name: 'Runs on' })
export const runsOnChipOf = (page: Page) => runsOnOf(page).locator('xpath=../..')
export const chooseRunsOn = async (page: Page, runsOn: string) => {
  const radio = runsOnChoiceOf(page).getByRole('radio', { name: runsOn })
  const notice = mainOf(page).getByText('Choose where this chat runs to send')
  await expect
    .poll(async () => ((await radio.isVisible()) ? 'choose' : (await notice.isVisible()) ? 'waiting' : 'chosen'))
    .not.toBe('waiting')
  if (await radio.isVisible()) await radio.click()
  await expect(runsOnChoiceOf(page)).toHaveCount(0)
}
export const newRuntimeChat = async (page: Page, name: string, runsOn: string | null = 'HQ runtime') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  if (runsOn) await chooseRunsOn(page, runsOn)
  return page.url().split('/').at(-1) ?? ''
}

const chipNames = {
  harness: /^Model: (Claude Code|Codex) · /,
  hq: /^Model: (?!Claude Code · |Codex · |Model chosen at first prompt$)/,
  routed: /^Model: (?!Claude Code · |Codex · )/,
  any: /^Model: /,
}
export const chipOf = (page: Page, kind: keyof typeof chipNames) =>
  mainOf(page).getByRole('button', { name: chipNames[kind] })
export const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
export const openSession = async (page: Page) => {
  await chipOf(page, 'routed').click()
  await expect(sessionOf(page)).toBeVisible()
}
export const newSession = async (page: Page, tool: string, name = `${tool} on my machine`) => {
  const chatId = await newRuntimeChat(page, name, null)
  await expect(chipOf(page, 'harness')).toHaveText(`${tool} · subscription`)
  return chatId
}
export const modeOf = (page: Page) => mainOf(page).getByRole('group', { name: 'Mode' })
export const modeRadioOf = (page: Page, name: 'Plan' | 'Auto') => modeOf(page).getByRole('radio', { name })

export const openMenu = async (page: Page) => {
  await switcherOf(page).click()
  await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeVisible()
}

export const switchWorkspace = async (page: Page, workspaceName: string) => {
  await switcherOf(page).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${workspaceName}`) }).click()
  await expect(switcherOf(page)).toContainText(workspaceName)
}

export const menuItemNamesOf = async (page: Page) => {
  await openMenu(page)
  const itemNames = await page
    .getByRole('menuitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim()))
  await page.keyboard.press('Escape')
  return itemNames
}

export const logOutOf = async (page: Page, workspaceName: string) => {
  await openMenu(page)
  await page.getByRole('menuitem', { name: `Log out of ${workspaceName}` }).click()
  await page
    .getByRole('dialog', { name: `Log out of ${workspaceName}` })
    .getByRole('button', { name: 'Log out' })
    .click()
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

const toolStep = 'Used whoami (fake)'
export const toolScript = { steps: [{ tool: 'fake-whoami' }], text: 'Checked who I am.' }

export const accountOf = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`
export const logInAtFakeProvider = (context: BrowserContext, account: string) =>
  context.addCookies([{ name: 'fake_mcp_user', value: account, url: fakeMcpUrl }])
export const connectionsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Connections' })
export const openMyConnections = async (page: Page, workspace = 'workspace-acme') => {
  await page.goto(`/w/${workspace}/profile`)
  await connectionsOf(page).getByRole('tab', { name: 'My connections' }).click()
}
export const connectedRowOf = (page: Page) => connectionsOf(page).getByRole('listitem').filter({ hasText: 'fake' })
export const inPopup = async (page: Page, open: () => Promise<void>) => {
  const popup = page.waitForEvent('popup')
  await open()
  await (await popup).waitForEvent('close')
}
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

export const githubSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'GitHub' })
export const newChatDialogOf = (page: Page) => page.getByRole('dialog', { name: 'New chat' })
export const configureGitHubApp = async (page: Page) => {
  const app = (await (await fetch(`${serverUrl}/test/github-app`)).json()) as Record<string, string>
  await openSettings(page)
  const section = githubSectionOf(page)
  await section.getByLabel('App id').fill(app.appId ?? '')
  await section.getByLabel('Client id').fill(app.clientId ?? '')
  await section.getByLabel('Private key').fill(app.privateKey ?? '')
  await section.getByLabel('Client secret').fill(app.clientSecret ?? '')
  await section.getByLabel('Webhook secret').fill('e2e-webhook-secret')
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText('Saved')).toBeVisible()
  return app
}

export const newDevChat = async (page: Page, name: string, repository: string) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(page)
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('radio', { name: 'Dev', exact: true }).check()
  await dialog.getByLabel('Repository').selectOption(repository)
  await expect(dialog.getByLabel('Base branch')).toHaveValue('main')
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  await chooseRunsOn(page, 'HQ runtime')
  return page.url().split('/').at(-1) ?? ''
}
