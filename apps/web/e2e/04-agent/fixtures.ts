import { expect, type Page } from '@playwright/test'
import { machineTest, mainOf, messageContaining, newRuntimeChat, newSession, workingIndicatorOf } from '../fixtures.ts'
import type { WorkerStack } from '../stack.ts'

export * from '../fixtures.ts'

export const newSessionNotice = 'The agent started a new session; it does not remember earlier messages'
export const delegationsFinished = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(async () =>
      (await workerStack.database.$client`select status from delegations where chat_id = ${chatId}`).map(
        ({ status }) => status,
      ),
    )
    .toEqual(['finished'])

export type Harness = { name: 'Pi' | 'Claude Code' | 'Codex'; machine?: { owner: string; signedIn: string } }
export const harnesses: Harness[] = [
  { name: 'Pi' },
  { name: 'Claude Code', machine: { owner: 'member-alice', signedIn: 'claude-code' } },
  { name: 'Codex', machine: { owner: 'member-alice', signedIn: 'codex' } },
]
export const forEachHarness = (declare: (harness: Harness) => void) => {
  for (const harness of harnesses)
    machineTest.describe(() => {
      machineTest.use({ runtimeHost: !harness.machine })
      declare(harness)
    })
}

export const newOnlineSession = async (
  page: Page,
  tool: 'Claude Code' | 'Codex',
  workerStack: WorkerStack,
  name = `${tool} questions`,
) => {
  await expect
    .poll(
      async () =>
        (
          await workerStack.database.$client`
            select 1 from runtime_hosts where owner_id = 'member-alice' and status = 'online'
              and capacity->'signedIn' ? ${tool === 'Codex' ? 'codex' : 'claude-code'}`
        ).length,
    )
    .toBe(1)
  return newSession(page, tool, name)
}
export const newHarnessChat = async (
  page: Page,
  harness: Harness,
  name: string,
  { machine, workerStack }: { machine: (query?: object) => Promise<unknown>; workerStack: WorkerStack },
) => {
  if (harness.name === 'Pi') return newRuntimeChat(page, name)
  await machine(harness.machine)
  return newOnlineSession(page, harness.name, workerStack, name)
}

export const questionOf = (page: Page) => mainOf(page).getByRole('form', { name: 'Question' })
export const turnEnded = async (page: Page, count = 1) => {
  await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(count)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
export const holdAnswers = async (page: Page) => {
  const held = Promise.withResolvers<void>()
  await page.route('**/api/chats/*/questions/*', async (route) => {
    await held.promise
    await route.continue()
  })
  const response = page.waitForResponse((candidate) => candidate.url().includes('/questions/'))
  return async () => {
    held.resolve()
    return (await response).status()
  }
}
