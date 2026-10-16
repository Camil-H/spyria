import { inChat, type MessageRow, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

const isApprovedPlan = (step: MessageRow['step']) =>
  step?.type === 'question' && step.kind === 'plan' && step.approved === true && typeof step.plan === 'string'
const isChecklist = (step: MessageRow['step']) => step?.type === 'plan'

export const approvedPlanOf = (messages: readonly MessageRow[]) => {
  const latest = messages
    .filter((message) => !message.step?.delegation && (isApprovedPlan(message.step) || isChecklist(message.step)))
    .reduce<MessageRow | undefined>(
      (newest, message) => (!newest || message.seq > newest.seq ? message : newest),
      undefined,
    )
  return latest?.step?.type === 'question' ? String(latest.step.plan) : null
}

export const getPlan = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => ({
  steps: snapshot.planSteps.filter(inChat(workspaceId, chatId)),
  approvedPlan: approvedPlanOf(snapshot.messages.filter(inChat(workspaceId, chatId))),
})
