import { readFile } from 'node:fs/promises'
import { expect, mainOf, openSettings, type Page, test } from './fixtures'
import type { WorkerStack } from './stack'

const auditSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Audit log' })
const recordsOf = (page: Page) =>
  auditSectionOf(page).getByRole('list', { name: 'Audit records' }).getByRole('listitem')
const recordOf = (page: Page, text: RegExp) => recordsOf(page).filter({ hasText: text })
const filtersOf = (page: Page) => auditSectionOf(page).getByRole('group', { name: 'Filters' })
const toolCallText = /Bob\s*Called a tool\s*crm · update/
const removalText = /Alice\s*Removed a member\s*Bob/
const inviteText = /Alice\s*Invited a member\s*nina@example\.com/

const insertApprovedGuestToolCall = (workerStack: WorkerStack) =>
  workerStack.database.$client`
    insert into tool_calls (workspace_id, chat_id, id, prompter_id, owner_id, server, tool, read_only, decision, decided_by, status, called_at)
    values ('workspace-acme', 'chat-research', 'guest-call', 'member-bob', 'member-alice', 'crm', 'update', false,
      'approved', 'member-alice', 'succeeded', now())`

const inviteNinaAndRemoveBob = async (page: Page, workerStack: WorkerStack) => {
  await openSettings(page, 'Manage Team')
  const members = mainOf(page).getByRole('region', { name: 'Members' })
  const inviteForm = members.getByRole('form', { name: 'Invite member' })
  await inviteForm.getByRole('textbox', { name: 'Email' }).fill('nina@example.com')
  await inviteForm.getByRole('button', { name: 'Invite' }).click()
  await expect(members.getByRole('list', { name: 'Pending invites' })).toContainText('nina@example.com')
  await members.getByRole('button', { name: 'Remove Bob' }).click()
  await page.getByRole('dialog', { name: 'Remove member' }).getByRole('button', { name: 'Remove' }).click()
  await expect(members.getByRole('button', { name: 'Remove Bob' })).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (
          await workerStack.database
            .$client`select removed_at from memberships where user_id = 'member-bob' and workspace_id = 'workspace-acme'`
        )[0]?.removed_at,
    )
    .not.toBeNull()
  await insertApprovedGuestToolCall(workerStack)
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Audit log', exact: true }).click()
  await expect(recordOf(page, inviteText)).toHaveCount(1)
}

const indexOfRecord = async (page: Page, text: RegExp) =>
  (await recordsOf(page).allTextContents()).findIndex((recordText) => text.test(recordText))

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. invites, removals and an approved guest tool call are listed newest first; the tool call expands to its server, tool and decision', async ({
  page,
  workerStack,
}) => {
  await inviteNinaAndRemoveBob(page, workerStack)
  const toolCallIndex = await indexOfRecord(page, toolCallText)
  const removalIndex = await indexOfRecord(page, removalText)
  const inviteIndex = await indexOfRecord(page, inviteText)
  expect(toolCallIndex).toBe(0)
  expect(removalIndex).toBeGreaterThan(toolCallIndex)
  expect(inviteIndex).toBeGreaterThan(removalIndex)

  await recordOf(page, toolCallText).getByRole('button').click()
  const details = recordOf(page, toolCallText).getByRole('definition')
  const labels = recordOf(page, toolCallText).getByRole('term')
  await expect(labels).toContainText([
    'Chat',
    'Server',
    'Tool',
    'Read only',
    'Decision',
    'Decided by',
    'Owner',
    'Status',
  ])
  await expect(details).toContainText(['Research', 'crm', 'update', 'No', 'approved', 'Alice', 'Alice', 'succeeded'])
})

test('2. filtering by person and type narrows the list, and a date range leaves out older rows', async ({
  page,
  workerStack,
}) => {
  await workerStack.database.$client`
    insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
    values ('workspace-acme', 'old-invite', 'member.invited', 'member-alice', '{"email":"old@example.com","role":"member"}',
      now() - interval '10 days')`
  await inviteNinaAndRemoveBob(page, workerStack)
  await expect(recordOf(page, /old@example\.com/)).toHaveCount(1)

  await filtersOf(page).getByRole('combobox', { name: 'Person' }).selectOption({ label: 'Alice' })
  await expect(recordOf(page, toolCallText)).toHaveCount(0)
  await expect(recordOf(page, removalText)).toHaveCount(1)
  await expect(recordOf(page, /Removed a member from a chat/).first()).toBeVisible()

  await filtersOf(page).getByRole('combobox', { name: 'Type' }).selectOption('Members')
  await expect(recordOf(page, /Removed a member from a chat/)).toHaveCount(0)
  await expect(recordsOf(page)).toHaveCount(3)
  await expect(recordOf(page, removalText)).toHaveCount(1)
  await expect(recordOf(page, inviteText)).toHaveCount(1)

  const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10)
  await filtersOf(page).getByLabel('From').fill(yesterday)
  await expect(recordOf(page, /old@example\.com/)).toHaveCount(0)
  await expect(recordsOf(page)).toHaveCount(2)
})

test('3. Export CSV downloads the filtered rows with a header', async ({ page, workerStack }) => {
  await inviteNinaAndRemoveBob(page, workerStack)
  await filtersOf(page).getByRole('combobox', { name: 'Type' }).selectOption('Members')
  await expect(recordOf(page, toolCallText)).toHaveCount(0)
  await expect(recordsOf(page)).toHaveCount(2)
  const shownTexts = await recordsOf(page).allTextContents()

  const downloading = page.waitForEvent('download')
  await filtersOf(page).getByRole('button', { name: 'Export CSV' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('audit-log.csv')
  const [header, ...rows] = (await readFile(await download.path(), 'utf8')).trimEnd().split('\n')
  expect(header).toBe('Time,Person,Action,Target,Details')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain(',Alice,Removed a member,Bob,')
  expect(rows[1]).toContain(',Alice,Invited a member,nina@example.com,Role: member; Email: nina@example.com')
  expect(shownTexts[0]).toMatch(removalText)
  expect(shownTexts[1]).toMatch(inviteText)
})

test('4. retention starts at Forever; 30 days is saved and shows in the log itself', async ({ page }) => {
  await openSettings(page, 'Audit log')
  const retentionForm = auditSectionOf(page).getByRole('form', { name: 'Retention' })
  await expect(retentionForm.getByRole('combobox', { name: 'Keep audit records' })).toHaveValue('forever')
  await expect(retentionForm).toContainText('Audit records are kept: Forever')

  await retentionForm.getByRole('combobox', { name: 'Keep audit records' }).selectOption('days')
  await retentionForm.getByRole('spinbutton', { name: 'Days' }).fill('30')
  await retentionForm.getByRole('button', { name: 'Save' }).click()
  await expect(retentionForm).toContainText('Audit records are kept: 30 days')
  await expect(recordsOf(page).first()).toContainText(/Alice\s*Changed how long audit records are kept\s*30 days/)

  await page.reload()
  await expect(retentionForm.getByRole('spinbutton', { name: 'Days' })).toHaveValue('30')
})

test.describe('4. as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('Bob gets "Only workspace admins can see this page" and no audit log', async ({ page }) => {
    await page.goto('/w/workspace-acme/settings/audit')
    await expect(mainOf(page).getByText('Only workspace admins can see this page')).toBeVisible()
    await expect(auditSectionOf(page)).toHaveCount(0)
  })
})
