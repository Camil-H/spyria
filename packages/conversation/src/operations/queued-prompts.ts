import type { UnitOfWork } from '../contracts/transactor.ts'
import { PromptPickedUp } from '../domain/errors.ts'
import type { Message } from '../domain/message.ts'
import { isQueuedPrompt } from '../domain/queued-prompts.ts'

export const requireQueuedIfPrompt = async ({ chats, messages }: UnitOfWork, message: Message) => {
  if ((await chats.get(message.chatId)).type !== 'runtime') return
  if (!isQueuedPrompt(message, await messages.replies(message.id))) throw new PromptPickedUp()
}
