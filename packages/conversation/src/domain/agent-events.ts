export type AgentEvent = Readonly<{ id: string; kind: string; timestamp: string; [field: string]: unknown }>
export type TurnOutcome = 'finished' | 'error' | 'stuck'
export type AgentProjection =
  | { type: 'message'; kind: 'agent' | 'tool-call'; body: string }
  | { type: 'detail'; actionId: string; detail: string }
  | { type: 'turn-end'; outcome: TurnOutcome }
  | undefined

type Fields = Record<string, unknown> | undefined

export const agentNotices = {
  noHost: 'No runtime host is available',
  couldNotStart: 'The agent could not start',
  stoppedWithError: 'The agent stopped with an error',
  noReply: 'The agent finished without a reply',
  hostOffline: 'The runtime host is offline',
  stoppedEarly: 'The agent stopped before finishing',
  noResponse: 'The agent did not respond',
  newSession: 'The agent started a new session; it does not remember earlier messages',
}
export const waitingNotices = [
  agentNotices.noHost,
  agentNotices.couldNotStart,
  agentNotices.hostOffline,
  agentNotices.newSession,
]
export const stoppedByNoticeOf = (memberName: string) => `Stopped by ${memberName}`
export const silentTurnMilliseconds = 10 * 60_000
export const agentSweepIntervalMilliseconds = 60_000
const turnOutcomes: readonly string[] = ['finished', 'error', 'stuck']

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((part) => String((part as Fields)?.text ?? '')).join('') : ''
const messageOf = (kind: 'agent' | 'tool-call', body: unknown): AgentProjection =>
  typeof body === 'string' && body.trim() !== '' ? { type: 'message', kind, body } : undefined

export const isStoredAgentEvent = (event: AgentEvent) =>
  event.kind !== 'StreamingDeltaEvent' && !(event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state')

export const streamedTextOf = (event: AgentEvent) =>
  event.kind === 'StreamingDeltaEvent' && typeof event.content === 'string' ? event.content : undefined

export const agentProjectionOf = (event: AgentEvent): AgentProjection => {
  const action = event.action as Fields
  const observation = event.observation as Fields
  if (event.kind === 'MessageEvent' && event.source === 'agent')
    return messageOf('agent', textOf((event.llm_message as Fields)?.content))
  if (event.kind === 'ActionEvent' && action?.kind === 'TerminalAction') return messageOf('tool-call', action.command)
  if (event.kind === 'ActionEvent' && action?.kind === 'FinishAction') return messageOf('agent', action.message)
  if (event.kind === 'ObservationEvent' && observation?.kind === 'TerminalObservation')
    return { type: 'detail', actionId: String(event.action_id), detail: textOf(observation.content) }
  if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status')
    return turnOutcomes.includes(String(event.value))
      ? { type: 'turn-end', outcome: event.value as TurnOutcome }
      : undefined
  return undefined
}

export const turnEndNoticeOf = (outcome: TurnOutcome, hasReply: boolean) =>
  outcome !== 'finished' ? agentNotices.stoppedWithError : hasReply ? undefined : agentNotices.noReply

export const reopenedTurnOutcomeOf = (executionStatus: string): TurnOutcome | undefined => {
  if (executionStatus === 'running') return undefined
  return executionStatus === 'error' || executionStatus === 'stuck' ? executionStatus : 'finished'
}

export const startFailureNoticeOf = (failure: string | null) =>
  failure === 'no_host' || failure === 'no_capacity' ? agentNotices.noHost : agentNotices.couldNotStart
