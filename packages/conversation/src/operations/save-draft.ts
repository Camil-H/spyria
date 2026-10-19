import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'
import type { DraftRepository } from '../contracts/repositories.ts'

type Dependencies = { drafts: DraftRepository }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }

export const saveDraft = ({ drafts }: Dependencies, input: Input) =>
  drafts.replace({ ...input, text: input.text.trim() === '' ? '' : input.text })
