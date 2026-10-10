import {
  type Fields,
  keptOutputOf,
  pathOf,
  type StepDelegation,
  type StoredStep,
  type ThoughtStep,
  textOf,
} from './agent-steps.ts'
import { toolDisplayNameOf } from './tool-calls.ts'

export type AgentEvent = Readonly<{ id: string; kind: string; timestamp: string; [field: string]: unknown }>
export type TurnOutcome = 'finished' | 'error' | 'stuck'
export type AgentProjection =
  | { type: 'message'; body: string; kind?: 'notice'; thought?: ThoughtStep }
  | { type: 'step'; step: StoredStep; id?: string }
  | { type: 'observation'; actionId: string; observation: Fields }
  | { type: 'turn-end'; outcome: TurnOutcome }
  | undefined

export const agentNotices = {
  noHost: 'No runtime host is available',
  couldNotStart: 'The agent could not start',
  stoppedWithError: 'The agent stopped with an error',
  noReply: 'The agent finished without a reply',
  hostOffline: 'The runtime host is offline',
  stoppedEarly: 'The agent stopped before finishing',
  noResponse: 'The agent did not respond',
  newSession: 'The agent started a new session; it does not remember earlier messages',
  contextCondensed: 'Context condensed · earlier steps summarized',
}
export const waitingNotices = [
  agentNotices.noHost,
  agentNotices.couldNotStart,
  agentNotices.hostOffline,
  agentNotices.newSession,
]
export const stoppedByPrefix = 'Stopped by '
export const stoppedByNoticeOf = (memberName: string) => `${stoppedByPrefix}${memberName}`
export const silentTurnMilliseconds = 10 * 60_000
export const agentSweepIntervalMilliseconds = 60_000
const turnOutcomes: readonly string[] = ['finished', 'error', 'stuck']

const fileOperations: Record<string, 'read' | 'create'> = { view: 'read', create: 'create' }
const nonBlank = (text: unknown) => (typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined)
const messageOf = (body: unknown): AgentProjection => {
  const text = nonBlank(body)
  return text === undefined ? undefined : { type: 'message', body: text }
}
const stepOf = (step: StoredStep): AgentProjection => ({ type: 'step', step })
const thoughtOf = (texts: unknown[], durationMilliseconds: number | null): ThoughtStep | undefined => {
  const text = [...new Set(texts.map(nonBlank).filter((part) => part !== undefined))].join('\n\n')
  return text === '' ? undefined : { type: 'thought', text, durationMilliseconds }
}

const actionStepOf = (event: AgentEvent, action: Fields): StoredStep | undefined => {
  if (action?.kind === 'TerminalAction')
    return {
      type: 'command',
      command: String(action.command),
      exitCode: null,
      durationMilliseconds: null,
      ...keptOutputOf(''),
    }
  if (action?.kind === 'FileEditorAction')
    return {
      type: 'file',
      operation: fileOperations[String(action.command)] ?? 'edit',
      path: pathOf(action.path),
      added: 0,
      removed: 0,
      diff: [],
    }
  if (action?.kind === 'TaskTrackerAction')
    return Array.isArray(action.task_list)
      ? {
          type: 'plan',
          items: action.task_list.map((task: Fields) => ({
            title: String(task?.title ?? ''),
            status: String(task?.status ?? 'todo').replace('_', '-'),
          })),
        }
      : undefined
  const toolCall = event.tool_call as Fields
  const name = String(event.tool_name ?? toolCall?.name ?? action?.kind)
  return action
    ? {
        type: 'tool',
        name: action.kind === 'MCPToolAction' ? toolDisplayNameOf(name) : name,
        arguments: String(toolCall?.arguments ?? JSON.stringify(action)),
        result: null,
      }
    : undefined
}

const acpDiffOf = (event: AgentEvent) => (event.content as Fields[] | undefined)?.find((part) => part?.type === 'diff')
const acpStepOf = (event: AgentEvent): StoredStep => {
  const title = String(event.title)
  const rawInput = (event.raw_input ?? {}) as Fields
  const path = pathOf(rawInput?.file_path ?? acpDiffOf(event)?.path)
  if (event.tool_kind === 'execute')
    return { type: 'command', command: title, exitCode: null, durationMilliseconds: null, ...keptOutputOf('') }
  if (event.tool_kind === 'edit')
    return {
      type: 'file',
      operation: title.startsWith('Write') ? 'create' : 'edit',
      path,
      added: 0,
      removed: 0,
      diff: [],
    }
  if (event.tool_kind === 'read') return { type: 'file', operation: 'read', path, added: 0, removed: 0, diff: [] }
  return { type: 'tool', name: toolDisplayNameOf(title), arguments: JSON.stringify(rawInput), result: null }
}
const acpToolCallProjectionOf = (event: AgentEvent): AgentProjection => {
  const id = String(event.tool_call_id)
  const rawOutput = event.raw_output
  const contentText = textOf((event.content as Fields[] | undefined)?.map((part) => part?.content))
  const diff = acpDiffOf(event)
  if (event.status === 'completed' || event.status === 'failed')
    return {
      type: 'observation',
      actionId: id,
      observation: {
        command: (event.raw_input as Fields)?.command,
        content: [{ text: typeof rawOutput === 'string' ? rawOutput : contentText || textOf(rawOutput) }],
        old_content: diff?.old_text,
        new_content: diff?.new_text,
        is_error: event.status === 'failed',
      },
    }
  return event.status === 'pending' ? { type: 'step', step: acpStepOf(event), id } : undefined
}

export const subagentDelegationOf = (
  event: AgentEvent,
  replies: readonly { id: string; step: StoredStep | null }[],
): StepDelegation | undefined => {
  const host = replies.findLast(
    ({ id, step }) =>
      step?.type === 'tool' && step.name === 'Task' && step.result === null && id !== event.tool_call_id,
  )
  return host && { id: host.id, model: '', modelName: '', task: '' }
}

export const isFinishEvent = (event: AgentEvent) =>
  event.kind === 'ActionEvent' && (event.action as Fields)?.kind === 'FinishAction'

export const isStoredAgentEvent = (event: AgentEvent) =>
  event.kind !== 'StreamingDeltaEvent' && !(event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state')

export const streamedTextOf = (event: AgentEvent) => {
  if (event.kind !== 'StreamingDeltaEvent') return undefined
  const content = typeof event.content === 'string' ? event.content : ''
  const reasoning = typeof event.reasoning_content === 'string' ? event.reasoning_content : ''
  return content === '' && reasoning !== ''
    ? { text: reasoning, isReasoning: true }
    : { text: content, isReasoning: false }
}

export const agentProjectionOf = (event: AgentEvent, previousTimestamp: string | null): AgentProjection => {
  const action = event.action as Fields
  const durationMilliseconds =
    previousTimestamp === null ? null : Date.parse(event.timestamp) - Date.parse(previousTimestamp)
  if (event.kind === 'MessageEvent' && event.source === 'agent')
    return messageOf(textOf((event.llm_message as Fields)?.content))
  if (isFinishEvent(event)) {
    const message = messageOf(action?.message)
    const thought = thoughtOf([event.reasoning_content], durationMilliseconds)
    return message?.type === 'message' && thought ? { ...message, thought } : message
  }
  if (event.kind === 'ACPToolCallEvent') return acpToolCallProjectionOf(event)
  if (event.kind === 'ActionEvent' && action?.kind === 'ThinkAction') {
    const thought = thoughtOf([event.reasoning_content, textOf(event.thought), action.thought], durationMilliseconds)
    return thought && stepOf(thought)
  }
  if (event.kind === 'ActionEvent') {
    const step = actionStepOf(event, action)
    const thought = thoughtOf([event.reasoning_content, textOf(event.thought)], durationMilliseconds)
    return step && stepOf(thought ? { ...step, thought } : step)
  }
  if (event.kind === 'ObservationEvent')
    return { type: 'observation', actionId: String(event.action_id), observation: event.observation as Fields }
  if (event.kind === 'AgentErrorEvent' || event.kind === 'ConversationErrorEvent')
    return stepOf({ type: 'error', message: String(event.error ?? event.detail ?? event.code ?? 'Unknown error') })
  if (event.kind === 'Condensation') return { type: 'message', body: agentNotices.contextCondensed, kind: 'notice' }
  if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status')
    return turnOutcomes.includes(String(event.value))
      ? { type: 'turn-end', outcome: event.value as TurnOutcome }
      : undefined
  return undefined
}

export const delegatedProjectionOf = (
  projection: AgentProjection,
  delegation: StepDelegation | undefined,
): AgentProjection => {
  if (!delegation) return projection
  if (projection?.type === 'step') return { ...projection, step: { ...projection.step, delegation } }
  return projection?.type === 'observation' ? projection : undefined
}

export const executionStatusOf = (event: AgentEvent) =>
  event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status' ? String(event.value) : undefined

export const turnEndNoticeOf = (outcome: TurnOutcome, hasReply: boolean) =>
  outcome !== 'finished' ? agentNotices.stoppedWithError : hasReply ? undefined : agentNotices.noReply

export const reopenedTurnOutcomeOf = (executionStatus: string): TurnOutcome | undefined => {
  if (executionStatus === 'running') return undefined
  return executionStatus === 'error' || executionStatus === 'stuck' ? executionStatus : 'finished'
}

export const startFailureNoticeOf = (failure: string | null) =>
  failure === 'no_host' || failure === 'no_capacity' ? agentNotices.noHost : agentNotices.couldNotStart
