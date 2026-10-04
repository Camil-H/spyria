import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import type { DraftRepository } from '../contracts/repositories.ts'

type Dependencies = { drafts: DraftRepository }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }

export const saveDraft = ({ drafts }: Dependencies, { workspaceId, chatId, memberId, text }: Input) =>
  text.trim() === '' ? drafts.remove(chatId, memberId) : drafts.save({ workspaceId, chatId, memberId, text })
