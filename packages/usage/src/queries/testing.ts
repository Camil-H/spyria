import { acme, alice, bob, createMockSnapshot, globex, type Snapshot } from '@spyria/db'
import { chatId } from '@spyria/kernel'

export const month = '2026-10'
export const earlier = '2026-08'
export const sonnet = 'anthropic/claude-sonnet-5-5'
export const haiku = 'anthropic/claude-haiku-5-5'
const entry = (
  chat: string,
  member: typeof alice,
  tokens: number,
  costMicros: number,
  calls: number,
  { at = month, model = sonnet } = {},
) => ({
  workspaceId: acme,
  month: at,
  chatId: chatId(chat),
  memberId: member,
  model,
  tokens,
  costMicros,
  calls,
})
export const snapshot: Snapshot = {
  ...createMockSnapshot(),
  usageEntries: [
    entry('chat-invoice-bug', alice, 800, 18_000, 1),
    entry('chat-invoice-bug', alice, 200, 2_000, 1, { model: haiku }),
    entry('chat-invoice-bug', bob, 300, 5_000, 1),
    entry('chat-research', bob, 50, 1_000, 1),
    entry('chat-welcome', alice, 10, 0, 1),
    entry('chat-invoice-bug', alice, 7, 70, 7, { at: earlier }),
    { ...entry('chat-launch-plan', alice, 999, 999, 9), workspaceId: globex },
  ],
}
