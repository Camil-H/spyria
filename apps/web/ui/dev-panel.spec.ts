import { configureGitHubApp, newDevChat } from '../e2e/07-dev-mode/fixtures'
import {
  expect,
  expectLooks,
  messageContaining,
  type Page,
  panelOf,
  panelTabOf,
  sendMessage,
  tabPanelOf,
  test,
  workingIndicatorOf,
} from './fixtures'

type AgentScript = (chatId: string, script: object) => Promise<void>

const commitCommand = (subject: string) =>
  `git add -A && git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qm '${subject}'`
const appEdit = (from: number, to: number) => ({
  edit: { path: 'src/app.ts', oldText: `export const total = ${from}\n`, newText: `export const total = ${to}\n` },
})
const finished = (page: Page) => expect(workingIndicatorOf(page)).toHaveCount(0)
const diffOf = (page: Page, path: string) => tabPanelOf(page).getByRole('table', { name: `Diff of ${path}` })
const cellsOfRow = (page: Page, path: string, row: number) =>
  diffOf(page, path).getByRole('row').nth(row).getByRole('cell')
const expectReadableRow = async (page: Page, path: string, row: number) => {
  const cells = cellsOfRow(page, path, row)
  const lineNumberBox = (await cells.first().boundingBox())!
  const codeBox = (await cells.last().boundingBox())!
  expect(lineNumberBox.width).toBeLessThan(40)
  expect(codeBox.height).toBeLessThan(24)
}
const runAgent = async (page: Page, agentScript: AgentScript, chatId: string, steps: object[], text: string) => {
  await agentScript(chatId, { steps, text })
  await sendMessage(page, text.replace(/\.$/, ''))
  await expect(messageContaining(page, text)).toHaveCount(1)
  await finished(page)
}
const devChatWithCommit = async (page: Page, agentScript: AgentScript, name: string, baseBranch = 'main') => {
  const chatId = await newDevChat(page, name, 'acme/app', baseBranch)
  await runAgent(page, agentScript, chatId, [appEdit(1, 2), { command: commitCommand('Fix the totals') }], 'Fixed.')
  await panelTabOf(page, 'Changes').click()
  return chatId
}

test.describe('Dev panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a chat owner, I collapse and expand the diff per file, read it unified in a narrow panel and side by side once the panel is 560px wide, with no layout choice; the panel has no Terminal tab', {
    tag: ['@spec-43'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    const chatId = await devChatWithCommit(page, agentScript, 'Diff totals')
    await runAgent(
      page,
      agentScript,
      chatId,
      [{ edit: { path: 'src/new.ts', create: 'export const added = true\n' } }],
      'Added a file.',
    )
    await expect(diffOf(page, 'src/new.ts')).toBeVisible()
    await expect(tabPanelOf(page).getByRole('radiogroup', { name: 'Diff layout' })).toHaveCount(0)

    await test.step('shows the diff unified at the default panel width, with narrow line numbers and code kept on one line', async () => {
      await expect(cellsOfRow(page, 'src/app.ts', 1)).toHaveText(['1', '', '- export const total = 1'])
      await expect(cellsOfRow(page, 'src/app.ts', 2)).toHaveText(['', '1', '+ export const total = 2'])
      await expectReadableRow(page, 'src/app.ts', 2)
    })

    await test.step('collapses and expands a file', async () => {
      const fileButton = tabPanelOf(page).getByRole('button', { name: /^src\/app\.ts/ })
      await fileButton.click()
      await expect(fileButton).toHaveAttribute('aria-expanded', 'false')
      await expect(diffOf(page, 'src/app.ts')).toHaveCount(0)
      await expect(diffOf(page, 'src/new.ts')).toBeVisible()
      await fileButton.click()
      await expect(diffOf(page, 'src/app.ts')).toBeVisible()
    })

    await test.step('switches to side by side when the panel is widened to 560px, without breaking words and with the halves lined up across files, and back when narrowed', async () => {
      const separator = page.getByRole('separator', { name: 'Resize panel' })
      await separator.focus()
      for (let press = 0; press < 13; press++) await page.keyboard.press('ArrowLeft')
      await expect(separator).toHaveAttribute('aria-valuenow', '568')
      await expect(cellsOfRow(page, 'src/app.ts', 1)).toHaveText([
        '1',
        '- export const total = 1',
        '1',
        '+ export const total = 2',
      ])
      await expectReadableRow(page, 'src/app.ts', 1)
      const rightHalfStartOf = async (path: string) => (await cellsOfRow(page, path, 1).nth(2).boundingBox())!.x
      expect(await rightHalfStartOf('src/new.ts')).toBeCloseTo(await rightHalfStartOf('src/app.ts'), 0)
      await expectLooks(page, panelOf(page), 'changes-side-by-side', {
        mask: [tabPanelOf(page).getByRole('region', { name: 'Branch status' })],
      })
      await page.keyboard.press('ArrowRight')
      await expect(separator).toHaveAttribute('aria-valuenow', '552')
      await expect(cellsOfRow(page, 'src/app.ts', 1)).toHaveText(['1', '', '- export const total = 1'])
    })

    await expect(panelTabOf(page, 'Terminal')).toHaveCount(0)
    await expect(panelOf(page).getByRole('textbox')).toHaveCount(0)
  })
})
