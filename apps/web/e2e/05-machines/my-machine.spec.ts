import { openPageAs } from '../stack'
import {
  expect,
  hostsSectionOf,
  llmSectionOf,
  machineSectionOf,
  machineToolOf,
  mainOf,
  messageContaining,
  newMachineSession,
  newSession,
  openProfile,
  openSettings,
  type Page,
  sendMessage,
  sessionStarted,
  hostTest as test,
  urlOf,
  workingIndicatorOf,
} from './fixtures'

const tools = [
  { name: 'Claude Code', signedIn: 'claude-code', login: 'claude-code' },
  { name: 'Codex', signedIn: 'codex', login: 'codex' },
]

test.describe('My machine', () => {
  const useToolDialogOf = (page: Page, toolName: string) => page.getByRole('dialog', { name: `Use ${toolName}` })
  const addMachine = async (page: Page) => {
    await openProfile(page)
    await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add my machine' })
    const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
    await dialog.getByRole('button', { name: 'Close' }).click()
    return command
  }

  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test.describe(() => {
    test.use({ signedInAs: 'member-bob' })

    test('As a member, I add my own machine: it pairs as personal, shows online in my profile only and is counted for those who manage runtime hosts', {
      tag: ['@spec-20'],
    }, async ({ page, browser, workerStack, pair }) => {
      await openProfile(page)
      await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add my machine' })
      await expect(dialog).toContainText(
        "This runs Spyria's agent container on this computer. Your sign-ins never leave this computer.",
      )
      await expect(dialog).toContainText('Never run it on a machine others use.')
      const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
      expect(command).toContain('docker run')
      expect(command).toMatch(/ spyria-host --personal https?:\/\/\S+\/h\/[A-HJ-NP-Z2-9]{8}$/)
      await dialog.getByRole('button', { name: 'Close' }).click()

      pair(urlOf(command), { personal: true, signedIn: ['claude-code'] })
      await expect(machineSectionOf(page)).toContainText('Online')
      await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
      await expect(machineToolOf(page, 'Codex')).toHaveText('Use Codex')
      await expect(machineSectionOf(page)).not.toContainText('docker exec')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)

      const adminPage = await openPageAs(browser, workerStack, 'member-alice')
      await openSettings(adminPage, 'Connect runtime')
      await expect(hostsSectionOf(adminPage)).toContainText(
        '1 member uses their machine: 1 signed in to Claude Code, 0 to Codex',
      )
      await expect(hostsSectionOf(adminPage).getByRole('listitem')).toHaveCount(0)
      await expect(hostsSectionOf(adminPage)).not.toContainText('My machine')
      await openProfile(adminPage)
      await expect(machineSectionOf(adminPage).getByRole('button', { name: 'Add my machine' })).toBeVisible()
      await expect(machineSectionOf(adminPage)).not.toContainText('Online')
      await adminPage.context().close()
    })
  })

  test.describe(() => {
    test.use({ signedInAs: 'member-bob' })

    test('As a member, I find one My machine section apart from LLM access: my machine, its status and Remove, then Use Claude Code and Use Codex with their state', {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, pair }) => {
      await openProfile(page)
      await expect(llmSectionOf(page)).not.toContainText('Claude Code')
      await expect(llmSectionOf(page)).not.toContainText('Codex')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toBeVisible()
      for (const toolName of ['Claude Code', 'Codex'])
        await expect(machineToolOf(page, toolName)).toHaveText(`Use ${toolName}`)

      pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['codex'] })
      await expect(machineSectionOf(page).getByText('Online', { exact: true })).toHaveCount(1)
      await expect(machineSectionOf(page).getByRole('button', { name: 'Remove' })).toBeVisible()
      await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)
      const codexState = machineToolOf(page, 'Codex')
      await expect(codexState).toHaveText('✓ Codex connected')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Use Codex' })).toHaveCount(0)
      await expect(machineToolOf(page, 'Claude Code')).toHaveText('Use Claude Code')
      await expect(machineSectionOf(page)).not.toContainText('Signed in to')
    })

    test('As a member without a machine, I use Claude Code through one command that starts my machine and signs in, followed to Online and ready', {
      tag: ['@spec-23'],
    }, async ({ page, pair }) => {
      await openProfile(page)
      await machineToolOf(page, 'Claude Code').click()
      const dialog = useToolDialogOf(page, 'Claude Code')
      await expect(dialog).toContainText(
        'signs in to Claude Code with your own plan. The sign-in never leaves this computer',
      )
      await expect(dialog).toContainText('Never run it on a machine others use.')
      await expect(dialog).toContainText('within 15 minutes, from the Spyria repo folder')
      const commandBox = dialog.getByRole('textbox', { name: 'Command' })
      const command = await commandBox.inputValue()
      expect(command).toMatch(/^docker build -q -t spyria-host apps\/host >\/dev\/null && docker rm -f spyria-host /)
      expect(command).toMatch(
        / spyria-host --personal http:\/\/host\.docker\.internal:\d+\/h\/[A-HJ-NP-Z2-9]{8} && docker exec -it spyria-host spyria-host login claude-code$/,
      )
      await expect(dialog).toContainText('Your machine: Waiting for the host')

      const machine = pair(urlOf(command), { personal: true, signedIn: [] })
      await expect(dialog).toContainText('Your machine: Online')
      await expect(commandBox).toHaveValue('docker exec -it spyria-host spyria-host login claude-code')
      machine.heartbeat(['claude-code'])
      await expect(dialog).toContainText(
        'Claude Code is ready: in a new Runtime chat, set Runs on to Local · Claude Code',
      )
      await expect(commandBox).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Close' }).click()

      await expect(machineSectionOf(page)).toContainText('Online')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Remove' })).toBeVisible()
      await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Use Claude Code' })).toHaveCount(0)
    })

    test('As a member whose machine is offline, I get Start with the command that starts it again, or set it up again with a new command that pairs it', {
      tag: ['@spec-20'],
    }, async ({ page, pair }) => {
      const startButtonOf = () => machineSectionOf(page).getByRole('button', { name: 'Start', exact: true })
      const machine = pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude-code'] })
      await expect(machineSectionOf(page)).toContainText('Online')
      await expect(startButtonOf()).toHaveCount(0)
      machine.disconnect()
      await expect(machineSectionOf(page)).toContainText('Offline')
      await startButtonOf().click()

      const dialog = page.getByRole('dialog', { name: 'Start my machine' })
      const commandBoxes = dialog.getByRole('textbox', { name: 'Command' })
      await expect(commandBoxes).toHaveValue('docker start spyria-host')
      await dialog.getByRole('button', { name: 'Set up again' }).click()
      await expect(dialog).toContainText('Your machine: Waiting for the host')
      const command = await commandBoxes.nth(1).inputValue()
      expect(command).toMatch(/ spyria-host --personal http:\/\/host\.docker\.internal:\d+\/h\/[A-HJ-NP-Z2-9]{8}$/)
      pair(urlOf(command), { personal: true, signedIn: ['claude-code'] })
      await expect(dialog).toContainText('Your machine: Online')
      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(startButtonOf()).toHaveCount(0)
      await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
    })

    test('As a member whose machine is signed in to Claude only, I get only the Codex sign-in command for Use Codex', {
      tag: ['@spec-23'],
    }, async ({ page, pair }) => {
      pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude-code'] })
      await expect(machineSectionOf(page)).toContainText('Online')
      await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
      await expect(machineSectionOf(page).getByRole('button', { name: 'Use Claude Code' })).toHaveCount(0)
      await expect(machineToolOf(page, 'Codex')).toHaveText('Use Codex')
      await expect(machineSectionOf(page)).not.toContainText('docker exec')
      await machineToolOf(page, 'Codex').click()
      const dialog = useToolDialogOf(page, 'Codex')
      await expect(dialog.getByRole('textbox', { name: 'Command' })).toHaveValue(
        'docker exec -it spyria-host spyria-host login codex',
      )
      await expect(dialog.getByRole('textbox')).toHaveCount(1)
      await expect(dialog).not.toContainText('docker build')
      await expect(dialog).not.toContainText('is ready')
    })
  })

  for (const tool of tools) {
    const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }

    test(`As a member whose ${tool.name} login expired, I get one sign-in error pointing to my Profile, no agent message, and ${tool.name} shown signed out`, {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, machine }) => {
      await machine(machineOf)
      await newSession(page, tool.name)
      await sendMessage(page, 'stub:auth-expired')
      const banner = mainOf(page).getByRole('alert')
      await expect(banner).toHaveText(`Authentication required — sign in to ${tool.name} again Open profile`)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(banner).toHaveCount(1)
      await expect(mainOf(page)).not.toContainText('OAuth session expired')
      await expect(mainOf(page)).not.toContainText('The agent stopped with an error')
      await page.reload()
      await expect(mainOf(page).getByRole('alert')).toHaveCount(1)
      await expect(mainOf(page)).not.toContainText('OAuth session expired')
      await banner.getByRole('link', { name: 'Open profile' }).click()
      await expect(page).toHaveURL(/\/profile#my-machine$/)
      await expect(machineSectionOf(page)).toBeInViewport()
      await expect(machineSectionOf(page).getByRole('button', { name: `Use ${tool.name}` })).toBeVisible()
      await expect(machineSectionOf(page).getByRole('button', { name: `${tool.name} connected` })).toHaveCount(0)
    })

    test(`As a member whose machine is signed out of ${tool.name}, I get its sign-in notice on a prompt that reaches no agent`, {
      tag: ['@spec-20'],
    }, async ({ page, workerStack, machine }) => {
      await machine({ owner: 'member-alice', signedIn: tool.login })
      await sessionStarted(
        workerStack,
        await newMachineSession(page, `${tool.name} signed out`, `Local · ${tool.name}`),
      )
      await machine({ signedIn: '' })
      await sendMessage(page, 'Answer without a sign-in')
      await expect(
        messageContaining(
          page,
          `Sign in to ${tool.name} on your machine: docker exec -it spyria-host spyria-host login ${tool.login}`,
        ),
      ).toHaveCount(1)
      expect((await machine()).prompts).toEqual([])
    })
  }
})
