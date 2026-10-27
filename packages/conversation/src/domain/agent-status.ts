import { agentNotices, stoppedByPrefix } from './agent-events.ts'

export type AgentStatus = 'working' | 'waiting' | 'error' | 'done'
type AgentActivity = Readonly<{
  kind: 'member' | 'agent' | 'step' | 'notice'
  body: string
  step: Readonly<{ type: string; [field: string]: unknown }> | null
}>

export const agentStatusLabels: Record<AgentStatus, string> = {
  working: 'The agent is working',
  waiting: 'The agent is waiting for an answer',
  error: 'The agent stopped with an error',
  done: 'The agent is done',
}

export const isOpenQuestion = (step: AgentActivity['step']) =>
  step?.type === 'question' && step.closed === undefined && step.answers === undefined && step.approved === undefined

const isInformationalNotice = (body: string) => body.startsWith(stoppedByPrefix) || body === agentNotices.newSession

const isFailure = ({ kind, body, step }: AgentActivity) =>
  (kind === 'step' && step?.type === 'error') || (kind === 'notice' && !isInformationalNotice(body))

export const agentStatusOf = ({
  isTurnActive,
  latestActivity,
}: {
  isTurnActive: boolean
  latestActivity: AgentActivity | undefined
}): AgentStatus | null => {
  if (latestActivity && isOpenQuestion(latestActivity.step)) return 'waiting'
  if (isTurnActive) return 'working'
  if (!latestActivity) return null
  return isFailure(latestActivity) ? 'error' : 'done'
}
