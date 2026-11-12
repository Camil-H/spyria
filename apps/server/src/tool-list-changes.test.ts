import { expect, test } from 'bun:test'
import { chatId, memberId, workspaceId } from '@spyria/kernel'
import {
  announceChatToolListChange,
  announcePrompter,
  announceToolListChange,
  recordToolListing,
  watchToolLists,
} from './tool-list-changes.ts'

const acme = workspaceId('workspace-acme')
const alice = memberId('member-alice')
const bob = memberId('member-bob')

test('a chat’s agent hears to list its tools again unless its last listing was for the turn’s prompter', () => {
  const research = chatId(`chat-${crypto.randomUUID()}`)
  const other = chatId(`chat-${crypto.randomUUID()}`)
  const heard: string[] = []
  const stopResearch = watchToolLists(acme, research, () => heard.push('research'))
  const stopOther = watchToolLists(acme, other, () => heard.push('other'))

  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['research'])
  recordToolListing(research, alice)
  announcePrompter(acme, research, alice)
  expect(heard).toEqual(['research'])
  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['research', 'research'])

  announceToolListChange(acme)
  expect(heard).toEqual(['research', 'research', 'research', 'other'])
  stopResearch()
  stopOther()
  announcePrompter(acme, research, alice)
  expect(heard).toHaveLength(4)
})

test('after its stream reconnects, a chat whose listing was for another member still hears to list again', () => {
  const research = chatId(`chat-${crypto.randomUUID()}`)
  const heard: string[] = []
  const stopFirst = watchToolLists(acme, research, () => heard.push('first'))
  recordToolListing(research, alice)
  stopFirst()
  const stopSecond = watchToolLists(acme, research, () => heard.push('second'))
  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['second'])
  stopSecond()
})

test('a tool server switched on or off in one chat makes only that chat’s agent list its tools again', () => {
  const research = chatId(`chat-${crypto.randomUUID()}`)
  const other = chatId(`chat-${crypto.randomUUID()}`)
  const heard: string[] = []
  const stopResearch = watchToolLists(acme, research, () => heard.push('research'))
  const stopOther = watchToolLists(acme, other, () => heard.push('other'))
  recordToolListing(research, alice)
  announceChatToolListChange(acme, research)
  expect(heard).toEqual(['research'])
  stopResearch()
  stopOther()
})
