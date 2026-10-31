import { expect, type Locator, type Page } from '@playwright/test'
import { test, type WorkerStack } from './stack.ts'
import { serverUrl } from './stack-ports.ts'

export * from '@playwright/test'
export { test } from './stack.ts'
export { serverUrl, ssoProviderIssuer, ssoServerUrl, ssoViteUrl } from './stack-ports.ts'

type Machine = {
  id: string
  conversations: { agent: Record<string, unknown>; secrets: object }[]
  prompts: string[]
  modelSwitches: string[]
  installs: number
}
type MachineQuery = {
  owner?: string
  signedIn?: string
  online?: string
  installFailure?: string
  holdInstall?: 'true' | 'false'
}

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
export const signedInMachine = { owner: 'member-alice', signedIn: 'claude-code' }

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
export const unreadIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Unread messages' })

export const messageContaining = (page: Page, text: string | RegExp) => messageItemsOf(page).filter({ hasText: text })
export const workingIndicatorOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
export const foldOf = (page: Page, steps: number) =>
  messageItemsOf(page).getByRole('button', { name: new RegExp(`^Worked for .+ · ${steps} steps$`) })
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

export const syncUsage = async (workerStack: WorkerStack) => {
  const synced = await fetch(`${serverUrl}/test/usage-sync?db=${workerStack.databaseName}`, { method: 'POST' })
  expect(synced.ok).toBe(true)
}
export const modelUsageRowOf = (page: Page, modelName: string) =>
  tabPanelOf(page)
    .getByRole('table', { name: 'Usage by model' })
    .getByRole('row', { name: new RegExp(`^${modelName}(?![\\w.])`) })
export const expectModelMetered = async (page: Page, workerStack: WorkerStack, modelName: string) => {
  const row = modelUsageRowOf(page, modelName)
  await expect
    .poll(async () => {
      await syncUsage(workerStack)
      return row.count()
    })
    .toBe(1)
  const [tokens = '', cost = '', requests = ''] = await row.getByRole('cell').allTextContents()
  expect(Number(tokens.replaceAll(',', ''))).toBeGreaterThan(0)
  expect(cost).toMatch(/^(\$\d+\.\d{2}|< \$0\.01)$/)
  expect(cost).not.toBe('$0.00')
  expect(Number(requests)).toBeGreaterThan(0)
}

export const openProfile = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
}
export const llmSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'LLM access' })
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

export const openSettings = async (page: Page, cardTitle: string) => {
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
  await mainOf(page).getByRole('link', { name: cardTitle, exact: true }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: cardTitle })).toBeVisible()
}
export const hostsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Runtime hosts' })
export const localRuntimesSectionOf = (page: Page) =>
  mainOf(page).getByRole('region', { name: 'Member local runtimes' })
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
export const newChatDialogOf = (page: Page) => page.getByRole('dialog', { name: 'New chat' })
const newChatQuestions = {
  isPublic: 'Is it public, so everyone in the workspace can join?',
  audience: 'Is it a team channel or an AI chat?',
  github: 'Does it need GitHub access?',
}
export const newChatAnswerOf = (dialog: Locator, question: keyof typeof newChatQuestions, answer: string) =>
  dialog.getByRole('radiogroup', { name: newChatQuestions[question] }).getByRole('radio', { name: answer, exact: true })
export const answerNewChannel = async (dialog: Locator, visibility: 'public' | 'private') => {
  await newChatAnswerOf(dialog, 'isPublic', visibility === 'public' ? 'Yes' : 'No').check()
  await newChatAnswerOf(dialog, 'audience', 'Team channel').check()
}
export const answerNewAiChat = async (dialog: Locator, { needsGitHub = false } = {}) => {
  await newChatAnswerOf(dialog, 'isPublic', 'No').check()
  await newChatAnswerOf(dialog, 'audience', 'AI chat').check()
  await newChatAnswerOf(dialog, 'github', needsGitHub ? 'Yes' : 'No').check()
}
export const newRuntimeChat = async (page: Page, name: string, runsOn: string | null = 'Spyria runtime') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(page)
  await answerNewAiChat(dialog)
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  if (runsOn) await chooseRunsOn(page, runsOn)
  return page.url().split('/').at(-1) ?? ''
}

const chipNames = {
  harness: /^Model: (Claude Code|Codex) · /,
  spyria: /^Model: (?!Claude Code · |Codex · |Model chosen at first prompt$)/,
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

export const switchWorkspace = async (page: Page, workspaceName: string) => {
  await switcherOf(page).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${workspaceName}`) }).click()
  await expect(switcherOf(page)).toContainText(workspaceName)
}

export const connectionsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Connections' })
export const openMyConnections = async (page: Page, workspace = 'workspace-acme') => {
  await page.goto(`/w/${workspace}/profile`)
  await connectionsOf(page).getByRole('tab', { name: 'My connections' }).click()
}
export const inPopup = async (page: Page, open: () => Promise<void>) => {
  const popup = page.waitForEvent('popup')
  await open()
  await (await popup).waitForEvent('close')
}

export const openChatRoles = async (page: Page) => {
  await openSettings(page, 'Roles and Permissions')
  await mainOf(page).getByRole('tab', { name: 'Chat roles' }).click()
}
export const rolesSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Chat roles' })
export const roleItemOf = (page: Page, name: string) =>
  rolesSectionOf(page).getByRole('list', { name: 'Chat roles' }).getByRole('listitem', { name, exact: true })
export const roleFormOf = (page: Page, label: string) => rolesSectionOf(page).getByRole('form', { name: label })
export const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete role' })
export const inviteRoleOptionsOf = async (page: Page) => {
  await tabPanelOf(page).getByRole('button', { name: 'Invite' }).click()
  return tabPanelOf(page)
    .getByRole('form', { name: 'Invite' })
    .getByLabel('Role')
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.textContent))
}
export const insertRole = (workerStack: WorkerStack, id: string, name: string, permissions: string[]) =>
  workerStack.database.$client`
    insert into chat_roles (workspace_id, id, name, permissions, built_in)
    values ('workspace-acme', ${id}, ${name}, ${workerStack.database.$client.array(permissions)}, false)`
export const fillRoleForm = async (page: Page, label: string, name: string, permissionLabels: string[]) => {
  const form = roleFormOf(page, label)
  await form.getByRole('textbox', { name: 'Name' }).fill(name)
  for (const permissionLabel of permissionLabels) await form.getByLabel(permissionLabel).check()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toHaveCount(0)
}
export const createRole = async (page: Page, name: string, permissionLabels: string[]) => {
  await openChatRoles(page)
  await rolesSectionOf(page).getByRole('button', { name: 'New role' }).click()
  await expect(roleFormOf(page, 'New role').getByLabel('Read the chat')).toBeDisabled()
  await expect(roleFormOf(page, 'New role').getByLabel('Read the chat')).toBeChecked()
  await fillRoleForm(page, 'New role', name, permissionLabels)
  await expect(roleItemOf(page, name)).toBeVisible()
}
export const editRole = async (page: Page, name: string, permissionLabels: string[]) => {
  await roleItemOf(page, name)
    .getByRole('button', { name: `Edit ${name}` })
    .click()
  await fillRoleForm(page, `Edit ${name}`, name, permissionLabels)
}
export const deleteRole = async (page: Page, name: string) => {
  await roleItemOf(page, name)
    .getByRole('button', { name: `Delete ${name}` })
    .click()
  await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
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
export const alicesWelcomeMessage = 'Thanks, glad to be here.'
export const quotedTime = '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC'
export const threadToggleName = /^\d+ repl(y|ies)/
export const threadToggleOf = (page: Page) => mainOf(page).getByRole('button', { name: threadToggleName })
export const repliesOf = (page: Page) =>
  mainOf(page).getByRole('list', { name: 'Thread replies' }).getByRole('listitem')
export const replyBoxOf = (page: Page) => mainOf(page).getByRole('textbox', { name: 'Reply' })
export const messageActionsOf = (message: Locator) => message.getByRole('toolbar', { name: 'Message actions' })
export const messageActionOf = async (message: Locator, actionName: string | RegExp) => {
  await message.hover()
  return messageActionsOf(message).getByRole('button', { name: actionName, exact: true })
}
export const replyInThread = async (page: Page, text: string) => {
  await (await messageActionOf(messageContaining(page, alicesWelcomeMessage).first(), 'Reply in thread')).click()
  await expect(replyBoxOf(page)).toBeFocused()
  await replyBoxOf(page).fill(text)
  await replyBoxOf(page).press('ControlOrMeta+Enter')
  await expect(repliesOf(page).filter({ hasText: text })).toHaveCount(1)
}
export const openWelcome = async (page: Page) => {
  await openChat(page, 'Welcome')
  await expect(messageContaining(page, alicesWelcomeMessage)).toBeVisible()
}

export const githubSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'GitHub' })
export const configureGitHubApp = async (page: Page) => {
  const app = (await (await fetch(`${serverUrl}/test/github-app`)).json()) as Record<string, string>
  await openSettings(page, 'Connect GitHub')
  const section = githubSectionOf(page)
  await section.getByRole('button', { name: /^(Create it manually|Change the App credentials)$/ }).click()
  await section.getByLabel('App id').fill(app.appId ?? '')
  await section.getByLabel('Client id').fill(app.clientId ?? '')
  await section.getByLabel('Private key').fill(app.privateKey ?? '')
  await section.getByLabel('Client secret').fill(app.clientSecret ?? '')
  await section.getByLabel('Webhook secret').fill('e2e-webhook-secret')
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText('Saved')).toBeVisible()
  return app
}
