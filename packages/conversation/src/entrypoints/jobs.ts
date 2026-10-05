import { messageId, type WorkspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { scriptedAgentReply } from '../domain/scripted-agent.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { appendAgentReply } from '../operations/append-agent-reply.ts'

const agentReplyPayload = z.object({ messageId: z.pipe(z.string().check(z.minLength(1)), z.transform(messageId)) })

export const conversationJobs = {
  [scriptedAgentReply.jobType]: (tx: Transaction, workspaceId: WorkspaceId, payload: unknown) =>
    appendAgentReply(
      { transactor: createZeroTransactor(tx, workspaceId) },
      {
        id: crypto.randomUUID(),
        answeredMessageId: agentReplyPayload.parse(payload).messageId,
        text: scriptedAgentReply.text,
      },
    ),
}
