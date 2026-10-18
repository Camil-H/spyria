import { inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getTerminal = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.messages
    .filter((message) => inChat(workspaceId, chatId)(message) && message.step?.type === 'command')
    .sort((first, second) => first.seq - second.seq)
    .map(({ id, step }) => ({
      stepId: id,
      command: String(step?.command ?? ''),
      output: String(step?.output ?? ''),
      exitCode: typeof step?.exitCode === 'number' ? step.exitCode : null,
    }))
