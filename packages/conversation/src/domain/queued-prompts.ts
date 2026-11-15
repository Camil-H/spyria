import { waitingNotices } from './agent-events.ts'
import { isDevLoopPrompt } from './dev-loop.ts'

type Reply = Readonly<{ kind: string; body: string }>
type Prompt = Readonly<{ id: string; kind: string; replyToId: string | null; pickedUpAt: unknown }>
type TurnPrompt = Readonly<{ authorId: string | null; step?: Readonly<{ type: string }> | null }>

export const isWaitingNotice = ({ kind, body }: Reply) => kind === 'notice' && waitingNotices.includes(body)

export const isQueuedPrompt = (prompt: Prompt, turnPromptId: string | null, replies: readonly Reply[]) =>
  prompt.kind === 'member' &&
  prompt.replyToId === null &&
  prompt.pickedUpAt === null &&
  prompt.id !== turnPromptId &&
  replies.every(isWaitingNotice)

export const joinsRunningTurn = (turnPrompt: TurnPrompt, queued: TurnPrompt) =>
  queued.authorId !== null &&
  queued.authorId === turnPrompt.authorId &&
  !isDevLoopPrompt(turnPrompt) &&
  !isDevLoopPrompt(queued)
