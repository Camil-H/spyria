import {
  chipOf,
  composerOf,
  expect,
  expectLooks,
  type Locator,
  mainOf,
  messageContaining,
  newRuntimeChat,
  openChat,
  type Page,
  runsOnChipOf,
  runsOnOf,
  sendButtonOf,
  sendMessage,
  sessionOf,
  test,
  workingIndicatorOf,
} from './fixtures'

const openMessageMenu = async (message: Locator) => {
  await message.hover()
  await message.getByRole('button', { name: 'Message actions' }).click()
}
const openMessageAction = async (page: Page, messageText: string, actionName: string) => {
  await openMessageMenu(messageContaining(page, messageText))
  await page.getByRole('menuitem', { name: actionName }).click()
}
const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete message' })
const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const turnsEnded = async (page: Page, count: number) => {
  await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(count)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('The element has no box')
  return { top: box.y, bottom: box.y + box.height, middle: box.y + box.height / 2 }
}
const runtimeStatusOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Runtime' })

test.describe('Chat view', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-01T12:34:00Z'))
    await page.goto('/')
  })

  test('As a member, I see a channel’s Send icon with its tooltip, the message menu revealed on keyboard focus, dialogs in the app text colour and readable links', async ({
    page,
    workerStack,
    refuseNextMessage,
  }) => {
    await openChat(page, 'Welcome')
    await expectLooks(page, mainOf(page), 'channel')
    await composerOf(page).fill('Hello')
    await test.step('shows Send as an icon with a tooltip', async () => {
      await expect(sendButtonOf(page)).toHaveText('')
      await sendButtonOf(page).hover()
      await expect(page.getByRole('tooltip', { name: 'Send (⌘↵)' })).toBeVisible()
    })
    await test.step('reveals the menu button on keyboard focus', async () => {
      const messageActionsButton = messageContaining(page, 'Thanks, glad to be here.').getByRole('button', {
        name: 'Message actions',
      })
      await messageActionsButton.focus()
      await expect(messageActionsButton).toBeVisible()
    })
    await test.step('uses the text color of the app for the delete message dialog title in dark mode', async () => {
      await page.emulateMedia({ colorScheme: 'dark' })
      await openMessageAction(page, 'Thanks, glad to be here.', 'Delete')
      const dialogTitleColor = await deleteDialogOf(page)
        .getByRole('heading', { name: 'Delete message' })
        .evaluate((element) => getComputedStyle(element).color)
      const pageTitleColor = await mainOf(page)
        .getByRole('heading', { level: 1 })
        .evaluate((element) => getComputedStyle(element).color)
      expect(dialogTitleColor).toBe(pageTitleColor)
      await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
    })
    await test.step('a link in a message has a contrast of at least 4.5:1 against the message background in light mode', async () => {
      await page.emulateMedia({ colorScheme: 'light' })
      const chatId = page.url().split('/').at(-1) ?? ''
      await workerStack.database.$client`
      insert into messages (workspace_id, chat_id, id, seq, kind, body, created_at)
      select workspace_id, id, 'link-message', (select coalesce(max(seq), 0) + 1 from messages where chat_id = ${chatId}), 'agent',
        'See [the docs](https://example.com/docs) for more.', now()
      from chats where id = ${chatId}`
      const link = messageContaining(page, 'See the docs').getByRole('link', { name: 'the docs' })
      await expect(link).toBeVisible()
      const { foreground, background } = await link.evaluate((element) => {
        const channelsOf = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number)
        let node: Element | null = element
        let background = [255, 255, 255, 1]
        for (; node; node = node.parentElement) {
          const channels = channelsOf(getComputedStyle(node).backgroundColor)
          if ((channels[3] ?? 1) > 0) {
            background = channels
            break
          }
        }
        return { foreground: channelsOf(getComputedStyle(element).color), background }
      })
      const luminanceOf = ([red = 0, green = 0, blue = 0]: number[]) => {
        const [r = 0, g = 0, b = 0] = [red, green, blue].map((channel) => {
          const value = channel / 255
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const [lighter = 0, darker = 0] = [luminanceOf(foreground), luminanceOf(background)].sort((x, y) => y - x)
      const ratio = (lighter + 0.05) / (darker + 0.05)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })
    await test.step('shows a refused message as not sent above the composer, with its text back in it', async () => {
      await refuseNextMessage()
      await sendMessage(page, 'Sent too fast')
      await expect(mainOf(page).getByRole('alert')).toHaveText('Not sent: Too many requests: try again in 12 seconds.')
      await expectLooks(page, mainOf(page), 'not-sent', { mask: [messageContaining(page, 'See the docs')] })
    })
  })

  test('As a member, I see the message list keep a gap on its right so step statuses and times stay clear of the scroll bar', async ({
    page,
  }) => {
    await openChat(page, 'Welcome')
    const messageList = mainOf(page).getByRole('list', { name: 'Messages' })
    const scrollArea = messageList.locator('..')
    const listBox = (await messageList.boundingBox())!
    const scrollAreaBox = (await scrollArea.boundingBox())!
    const scrollbarWidth = await scrollArea.evaluate(
      (element) => element.getBoundingClientRect().width - element.clientWidth,
    )
    expect(scrollAreaBox.x + scrollAreaBox.width - scrollbarWidth - (listBox.x + listBox.width)).toBeGreaterThanOrEqual(
      8,
    )
  })

  test('As a member, I see a runtime chat’s owner on the title row in bold, the branch above the text box and the Runs on and model chips under it', async ({
    page,
  }) => {
    await openChat(page, 'Invoice bug')
    await expectLooks(page, mainOf(page), 'runtime-chat')
    await test.step('puts the owner on the title row, aligned right, the git branch above the text box, aligned left, and the Runs on chip with the runtime status and the model chip in the bar under it, the status inside the Runs on chip', async () => {
      const titleBox = (await mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' }).boundingBox())!
      const ownerBox = (await mainOf(page).getByText('Agent acts as Alice').boundingBox())!
      const branchBox = (await mainOf(page).getByText('fix/invoice-tax').boundingBox())!
      const modelBox = (await chipOf(page, 'spyria').boundingBox())!
      const runtimeBox = (await mainOf(page).getByRole('status', { name: 'Runtime' }).boundingBox())!
      const composerBox = (await composerOf(page).boundingBox())!
      expect(Math.abs(ownerBox.y + ownerBox.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThan(16)
      expect(ownerBox.x).toBeGreaterThan(titleBox.x + titleBox.width)
      const header = mainOf(page).locator('header')
      await expect(header).not.toContainText('fix/invoice-tax')
      await expect(header).not.toContainText('Sonnet 5.5 (high)')
      await expect(header.getByRole('status', { name: 'Runtime' })).toHaveCount(0)
      expect(branchBox.y + branchBox.height).toBeLessThanOrEqual(composerBox.y)
      expect(composerBox.y - (branchBox.y + branchBox.height)).toBeLessThan(48)
      expect(Math.abs(branchBox.x - composerBox.x)).toBeLessThan(48)
      for (const chipBox of [modelBox, runtimeBox]) {
        expect(chipBox.y).toBeGreaterThanOrEqual(composerBox.y + composerBox.height)
        expect(chipBox.y - (composerBox.y + composerBox.height)).toBeLessThan(48)
      }
      const runsOnRight = await mainOf(page)
        .getByRole('combobox', { name: 'Runs on' })
        .evaluate((select) => select.getBoundingClientRect().right)
      expect(runtimeBox.x).toBeGreaterThan(runsOnRight)
      expect(runtimeBox.x - runsOnRight).toBeLessThan(24)
      expect(runtimeBox.x + runtimeBox.width).toBeLessThan(modelBox.x)
      expect(Math.abs(runtimeBox.y + runtimeBox.height / 2 - (modelBox.y + modelBox.height / 2))).toBeLessThan(4)
    })

    await test.step('shows the name of the member the agent acts as in bold', async () => {
      const ownerNameWeight = await mainOf(page)
        .getByText('Alice', { exact: true })
        .first()
        .evaluate((element) => Number(getComputedStyle(element).fontWeight))
      expect(ownerNameWeight).toBeGreaterThanOrEqual(600)
    })
  })

  test('As a prompter, I find the working directory above the text box, and Runs on and the model chip (model and effort only) in the bar under it', {
    tag: ['@spec-25', '@stage-e', '@stage-g'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Composer layout')
    await expect(workingDirectoryOf(page)).toHaveCount(0)

    await sendMessage(page, 'stub:hello')
    await turnsEnded(page, 1)
    await expect(chipOf(page, 'spyria')).toHaveText(/^Mistral Medium( \((low|medium|high)\))?$/)
    await chipOf(page, 'spyria').click()
    await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
    await page.keyboard.press('Escape')
    await expect(workingDirectoryOf(page)).toHaveText(/^workspace-\d+$/)
    await expect(workingDirectoryOf(page)).toHaveAttribute('title', /\/workspace-\d+$/)

    const textBox = await boxOf(composerOf(page))
    const runsOn = await boxOf(mainOf(page).getByRole('combobox', { name: 'Runs on' }))
    const model = await boxOf(chipOf(page, 'spyria'))
    expect((await boxOf(workingDirectoryOf(page))).bottom).toBeLessThanOrEqual(textBox.top)
    for (const control of [runsOn, model]) {
      expect(control.top).toBeGreaterThanOrEqual(textBox.bottom)
      expect(Math.abs(control.middle - runsOn.middle)).toBeLessThan(4)
    }
    await expectLooks(page, page, 'composer', { mask: [workingDirectoryOf(page)] })
  })

  test.describe(() => {
    test.use({ warmRuntimes: false, fakeBootHold: 'boot' })

    test('As a prompter, I see the runtime status inside the Runs on chip with a dot coloured by state: Not started, Starting…, Ready', {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, release }) => {
      const dotColourOf = () =>
        runtimeStatusOf(page)
          .locator('span')
          .first()
          .evaluate((dot) => getComputedStyle(dot).backgroundColor)
      const colourOf = (variable: string) =>
        page.evaluate((name) => {
          const probe = document.body.appendChild(document.createElement('span'))
          probe.style.backgroundColor = `var(${name})`
          const colour = getComputedStyle(probe).backgroundColor
          probe.remove()
          return colour
        }, variable)
      await openChat(page, 'Research')
      await expect(runsOnOf(page)).toHaveValue('runtime')
      await expect(runsOnChipOf(page).getByRole('status', { name: 'Runtime' })).toHaveText('Not started')
      await expect(mainOf(page).getByRole('status', { name: 'Runtime' })).toHaveCount(1)
      expect(await dotColourOf()).toBe(await colourOf('--color-grey-500'))
      const [runsOnRight, statusLeft] = await Promise.all([
        runsOnOf(page).evaluate((select) => select.getBoundingClientRect().right),
        runtimeStatusOf(page).evaluate((status) => status.getBoundingClientRect().left),
      ])
      expect(statusLeft).toBeGreaterThan(runsOnRight)
      expect(statusLeft - runsOnRight).toBeLessThan(24)

      await sendMessage(page, 'Start please')
      await expect(runtimeStatusOf(page)).toHaveText('Starting…')
      expect(await dotColourOf()).toBe(await colourOf('--color-primary-500'))
      await release('boot')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      expect(await dotColourOf()).toBe(await colourOf('--color-green-500'))
    })
  })
})
