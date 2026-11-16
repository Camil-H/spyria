import { openPageAs, type WorkerStack } from '../stack'
import {
  addLlmKey,
  addParticipant,
  expect,
  forEachHarness,
  mainOf,
  messageActionOf,
  messageContaining,
  messageItemsOf,
  newHarnessChat,
  newRuntimeChat,
  openChat,
  type Page,
  sendMessage,
  machineTest as test,
  turnEnded,
  withoutSteering,
  workingIndicatorOf,
} from './fixtures'

const handedToTheTurn = async (workerStack: WorkerStack, chatId: string, count = 1) => {
  const { $client: sql } = workerStack.database
  await expect
    .poll(async () => {
      const [row] = await sql`
        select count(*)::int as handed from messages
        where chat_id = ${chatId} and kind = 'member' and picked_up_at is not null`
      return row?.handed
    })
    .toBe(count + 1)
  await expect
    .poll(async () =>
      (await sql`select state from jobs where type = 'agent.join' and payload->>'chatId' = ${chatId}`).every(
        ({ state }) => state === 'done',
      ),
    )
    .toBe(true)
}
const queuedLabelOf = (page: Page, text: string) => messageContaining(page, text).getByText('Queued', { exact: true })

test.describe('Messages sent while the agent works', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I send a message while the agent runs a command, and the agent acts on it before its turn ends', {
    tag: ['@spec-60'],
  }, async ({ page, workerStack, release }) => {
    const chatId = await newRuntimeChat(page, 'Mid-turn command')
    await sendMessage(page, 'stub:command stub:linger Rename the module')
    await expect(messageContaining(page, 'sleep 2 && echo checked').getByRole('img', { name: 'Running' })).toBeVisible()
    await sendMessage(page, 'Use tabs too')
    await expect(messageContaining(page, 'Use tabs too')).toHaveCount(1)
    await expect(queuedLabelOf(page, 'Use tabs too')).toHaveCount(0)

    await handedToTheTurn(workerStack, chatId)
    await release('linger')
    await turnEnded(page, 1)
    await expect(messageItemsOf(page).nth(0)).toContainText('Rename the module')
    await expect(messageItemsOf(page).nth(-2)).toContainText('Use tabs too')
    await expect(messageItemsOf(page).nth(-1)).toContainText('Took in: Use tabs too.')
    await expect(messageItemsOf(page).nth(-1)).toContainText('Hello from the stub')
    await expect(messageContaining(page, '[t2]')).toHaveCount(0)
    await expect(await messageActionOf(messageItemsOf(page).nth(-2), 'Edit')).toHaveCount(0)
  })

  test("As a member, I send two messages while the agent works, and they're answered one by one in the order I sent them", {
    tag: ['@spec-60'],
  }, async ({ page, workerStack, release }) => {
    const chatId = await newRuntimeChat(page, 'Mid-turn pair')
    await sendMessage(page, 'stub:linger Rename the module')
    await expect(messageContaining(page, '[t1]')).toBeVisible()
    await sendMessage(page, 'First, use tabs')
    await expect(messageContaining(page, 'First, use tabs')).toHaveCount(1)
    await sendMessage(page, 'Then fix the imports')
    await expect(messageContaining(page, 'Then fix the imports')).toHaveCount(1)

    await handedToTheTurn(workerStack, chatId, 2)
    await release('linger')
    await turnEnded(page, 1)
    await expect(messageItemsOf(page).nth(-4)).toContainText('First, use tabs')
    await expect(messageItemsOf(page).nth(-3)).toContainText('Took in: First, use tabs.')
    await expect(messageItemsOf(page).nth(-2)).toContainText('Then fix the imports')
    await expect(messageItemsOf(page).nth(-1)).toContainText('Took in: Then fix the imports.')
  })

  test("As a second member, I send a message during someone else's turn, and it stays queued until that turn ends, then starts its own", {
    tag: ['@spec-60'],
  }, async ({ page, browser, workerStack, release }) => {
    const chatId = await newRuntimeChat(page, 'Mid-turn shared')
    await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Mistral')
    await openChat(bobPage, 'Mid-turn shared')
    await sendMessage(page, 'stub:linger Rename the module')
    await expect(messageContaining(bobPage, '[t1]')).toBeVisible()

    await sendMessage(bobPage, 'stub:hello Also add a changelog entry')
    await expect(queuedLabelOf(bobPage, 'Also add a changelog entry')).toBeVisible()
    await expect(queuedLabelOf(page, 'Also add a changelog entry')).toBeVisible()
    await release('linger')
    await turnEnded(bobPage, 2)
    await expect(queuedLabelOf(bobPage, 'Also add a changelog entry')).toHaveCount(0)
    await expect(messageItemsOf(bobPage).nth(-2)).toContainText('Also add a changelog entry')
    await expect(messageItemsOf(bobPage).nth(-1)).toContainText('[t2] Hello from the stub')
    await expect(messageContaining(bobPage, 'Took in:')).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member, I edit and then remove my queued message before the agent picks it up, and it never reaches the agent', {
    tag: ['@spec-60'],
  }, async ({ page, browser, workerStack, release }) => {
    const chatId = await newRuntimeChat(page, 'Mid-turn edits')
    await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Mistral')
    await openChat(bobPage, 'Mid-turn edits')
    await openChat(page, 'Mid-turn edits')
    await sendMessage(bobPage, 'stub:linger Rename the module')
    await expect(messageContaining(page, '[t1]')).toBeVisible()

    await sendMessage(page, 'Add tests')
    await expect(queuedLabelOf(page, 'Add tests')).toBeVisible()
    await (await messageActionOf(messageContaining(page, 'Add tests'), 'Edit')).click()
    await page.getByRole('textbox', { name: 'Edit message' }).fill('Add unit tests')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(messageContaining(page, 'Add unit tests')).toContainText('(edited)')
    await expect(queuedLabelOf(page, 'Add unit tests')).toBeVisible()
    await (await messageActionOf(messageContaining(page, 'Add unit tests'), 'Delete')).click()
    await page.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Delete' }).click()
    await expect(messageContaining(page, 'This message was deleted')).toBeVisible()

    await release('linger')
    await turnEnded(page, 1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('Add unit tests')
    await expect(messageContaining(page, '[t2]')).toHaveCount(0)
    await bobPage.context().close()
  })

  forEachHarness((harness) => {
    if (harness.name === 'Pi') return
    const lastItemOf = (page: Page) => messageItemsOf(page).last()

    test(`As an owner on a machine session, I send a message while the agent runs a command, and the agent acts on it before its turn ends [${harness.name}]`, {
      tag: ['@spec-60'],
    }, async ({ page, workerStack, release, machine }) => {
      const chatId = await newHarnessChat(page, harness, `${harness.name} mid-turn command`, { machine })
      await sendMessage(page, 'stub:command stub:linger Rename the module')
      await expect(
        messageContaining(page, 'sleep 2 && echo checked').getByRole('img', { name: 'Running' }),
      ).toBeVisible()
      await sendMessage(page, 'Use tabs too')
      await expect(messageContaining(page, 'Use tabs too')).toHaveCount(1)

      await handedToTheTurn(workerStack, chatId)
      await expect(queuedLabelOf(page, 'Use tabs too')).toHaveCount(0)
      await release('linger')
      await turnEnded(page, 1)
      const sent = messageContaining(page, 'Use tabs too').first()
      await expect(sent).not.toContainText('Hello from the stub')
      await expect(lastItemOf(page)).toContainText('Took in: Use tabs too.')
      await expect(lastItemOf(page)).toContainText('Hello from the stub')
      await expect(messageContaining(page, '[t2]')).toHaveCount(0)
      await expect(await messageActionOf(sent, 'Edit')).toHaveCount(0)
      expect((await machine()).prompts).toEqual(['stub:command stub:linger Rename the module'])
    })

    test(`As an owner on a machine session, I send two messages while the agent works, and they're answered one by one in the order I sent them [${harness.name}]`, {
      tag: ['@spec-60'],
    }, async ({ page, workerStack, release, machine }) => {
      const chatId = await newHarnessChat(page, harness, `${harness.name} mid-turn pair`, { machine })
      await sendMessage(page, 'stub:linger Rename the module')
      await expect(messageContaining(page, '[t1]')).toBeVisible()
      await sendMessage(page, 'First, use tabs')
      await expect(messageContaining(page, 'First, use tabs')).toHaveCount(1)
      await sendMessage(page, 'Then fix the imports')
      await expect(messageContaining(page, 'Then fix the imports')).toHaveCount(1)

      await handedToTheTurn(workerStack, chatId, 2)
      await release('linger')
      await turnEnded(page, 1)
      await expect(lastItemOf(page)).toContainText(
        'Took in: First, use tabs. Took in: Then fix the imports. Hello from the stub',
      )
      await expect(messageContaining(page, '[t2]')).toHaveCount(0)
      expect((await machine()).prompts).toEqual(['stub:linger Rename the module'])
    })

    test(`As an owner on a machine session, I stop a turn after my message joined it, and the turn ends with "Stopped by" under my message [${harness.name}]`, {
      tag: ['@spec-60'],
    }, async ({ page, workerStack, machine }) => {
      const chatId = await newHarnessChat(page, harness, `${harness.name} mid-turn stop`, { machine })
      await sendMessage(page, 'stub:long Sleep for a while')
      await expect(messageContaining(page, 'sleep 600').getByRole('img', { name: 'Running' })).toBeVisible()
      await sendMessage(page, 'Carry on')
      await expect(messageContaining(page, 'Carry on')).toHaveCount(1)

      await handedToTheTurn(workerStack, chatId)
      await mainOf(page).getByRole('button', { name: 'Stop' }).click()
      await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(messageItemsOf(page).filter({ hasText: /Carry on|Stopped by Alice/ })).toHaveText([
        /Carry on/,
        /Stopped by Alice/,
      ])
      await expect(lastItemOf(page)).toContainText('Stopped by Alice')
      await expect(mainOf(page)).not.toContainText('Hello from the stub')
      expect((await machine()).prompts).toEqual(['stub:long Sleep for a while'])
    })

    test(`As an owner on a machine session whose harness version doesn't advertise steering, my message stays queued and is sent as the next turn [${harness.name}]`, {
      tag: ['@spec-60'],
    }, async ({ page, release, machine }) => {
      await newHarnessChat(page, withoutSteering(harness), `${harness.name} mid-turn queued`, { machine })
      await sendMessage(page, 'stub:linger Rename the module')
      await expect(messageContaining(page, '[t1]')).toBeVisible()
      await sendMessage(page, 'Use tabs too')
      await expect(queuedLabelOf(page, 'Use tabs too')).toBeVisible()

      await release('linger')
      await turnEnded(page, 2)
      await expect(queuedLabelOf(page, 'Use tabs too')).toHaveCount(0)
      await expect(messageItemsOf(page).nth(-2)).toContainText('Use tabs too')
      await expect(messageItemsOf(page).nth(-1)).toContainText('[t2] Hello from the stub')
    })
  })
})
