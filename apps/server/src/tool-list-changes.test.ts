import { expect, test } from 'bun:test'
import type { Database } from '@spyria/db/postgres'
import { chatId, memberId, workspaceId } from '@spyria/kernel'
import { createToolListChanges, toolListChangesOf } from './tool-list-changes.ts'

const acme = workspaceId('workspace-acme')
const globex = workspaceId('workspace-globex')
const alice = memberId('member-alice')
const bob = memberId('member-bob')
const research = chatId('chat-research')
const other = chatId('chat-other')

test('a chat’s agent hears to list its tools again unless its last listing was for the turn’s prompter', () => {
  const { watchToolLists, announcePrompter, recordToolListing, announceToolListChange } = createToolListChanges()
  const heard: string[] = []
  const stopResearch = watchToolLists(acme, research, () => heard.push('research'))
  const stopOther = watchToolLists(acme, other, () => heard.push('other'))

  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['research'])
  recordToolListing(acme, research, alice)
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
  const { watchToolLists, announcePrompter, recordToolListing } = createToolListChanges()
  const heard: string[] = []
  const stopFirst = watchToolLists(acme, research, () => heard.push('first'))
  recordToolListing(acme, research, alice)
  stopFirst()
  const stopSecond = watchToolLists(acme, research, () => heard.push('second'))
  announcePrompter(acme, research, bob)
  expect(heard).toEqual(['second'])
  stopSecond()
})

test('a tool server switched on or off in one chat makes only that chat’s agent list its tools again', () => {
  const { watchToolLists, recordToolListing, announceChatToolListChange } = createToolListChanges()
  const heard: string[] = []
  const stopResearch = watchToolLists(acme, research, () => heard.push('research'))
  const stopOther = watchToolLists(acme, other, () => heard.push('other'))
  recordToolListing(acme, research, alice)
  announceChatToolListChange(acme, research)
  expect(heard).toEqual(['research'])
  stopResearch()
  stopOther()
})

test('chats with the same id in another workspace or another database neither hear nor overwrite each other’s listings', () => {
  const first = toolListChangesOf({} as Database)
  const second = toolListChangesOf({} as Database)
  const heard: string[] = []
  const stops = [
    first.watchToolLists(acme, research, () => heard.push('first acme')),
    first.watchToolLists(globex, research, () => heard.push('first globex')),
    second.watchToolLists(acme, research, () => heard.push('second acme')),
  ]

  first.recordToolListing(acme, research, bob)
  first.recordToolListing(globex, research, alice)
  second.recordToolListing(acme, research, alice)
  first.announcePrompter(acme, research, alice)
  expect(heard).toEqual(['first acme'])

  first.announceToolListChange(acme)
  first.announceChatToolListChange(acme, research)
  expect(heard).toEqual(['first acme', 'first acme', 'first acme'])
  for (const stop of stops) stop()
})
