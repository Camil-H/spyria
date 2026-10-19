import { acme, alice, bob, createMockSnapshot, globex, type Snapshot } from '@hq/db'
import { chatId } from '@hq/kernel'

export const month = '2026-10'
export const earlier = '2026-08'
const entry = (chat: string, member: typeof alice, tokens: number, costMicros: number, calls: number, at = month) => ({
  workspaceId: acme,
  month: at,
  chatId: chatId(chat),
  memberId: member,
  tokens,
  costMicros,
  calls,
})
export const snapshot: Snapshot = {
  ...createMockSnapshot(),
  usageEntries: [
    entry('chat-invoice-bug', alice, 1000, 20_000, 2),
    entry('chat-invoice-bug', bob, 300, 5_000, 1),
    entry('chat-research', bob, 50, 1_000, 1),
    entry('chat-welcome', alice, 10, 0, 1),
    entry('chat-invoice-bug', alice, 7, 70, 7, earlier),
    { ...entry('chat-launch-plan', alice, 999, 999, 9), workspaceId: globex },
  ],
}
