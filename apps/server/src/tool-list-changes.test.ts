import { expect, test } from 'bun:test'
import { chatId, memberId, workspaceId } from '@spyria/kernel'
import { announcePrompter, announceToolListChange, recordToolListing, watchToolLists } from './tool-list-changes.ts'

const acme = workspaceId('workspace-acme')
const alice = memberId('member-alice')
const bob = memberId('member-bob')

test('a chat’s agent hears to list its tools again when a turn’s prompter is not the member its last listing was for', () => {
  const research = chatId(`chat-${crypto.randomUUID()}`)
  const other = chatId(`chat-${crypto.randomUUID()}`)
  const heard: string[] = []
  const stopResearch = watchToolLists(acme, research, () => heard.push('research'))
  const stopOther = watchToolLists(acme, other, () => heard.push('other'))

  announcePrompter(acme, research, bob)
  expect(heard).toEqual([])
  recordToolListing(research, alice)
  announcePrompter(acme, research, alice)
  expect(heard).toEqual([])
  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['research'])

  announceToolListChange(acme)
  expect(heard).toEqual(['research', 'research', 'other'])
  stopResearch()
  stopOther()
  announcePrompter(acme, research, alice)
  expect(heard).toHaveLength(3)
})
