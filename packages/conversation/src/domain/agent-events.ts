import {
  type Fields,
  keptOutputOf,
  observedStep,
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
  | { type: 'observation'; actionId: string; observation: Fields; step?: StoredStep }
  | { type: 'turn-end'; outcome: TurnOutcome }
  | undefined

export const agentNotices = {
  noHost: 'No runtime host is available',
  couldNotStart: 'The agent could not start',
  stoppedWithError: 'The agent stopped with an error',
  noReply: 'The agent finished without a reply',
  hostOffline: 'The runtime host is offline',
  machineOffline: 'Your machine is offline',
  stoppedEarly: 'The agent stopped before finishing',
  noResponse: 'The agent did not respond',
  newSession: 'The agent started a new session; it does not remember earlier messages',
  contextCondensed: 'Context condensed · earlier steps summarized',
}
export const waitingNotices = [
  agentNotices.noHost,
  agentNotices.couldNotStart,
  agentNotices.hostOffline,
  agentNotices.machineOffline,
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

type AcpToolCall = {
  id: string
  title: string
  kind: unknown
  status: unknown
  rawInput: Fields
  rawOutput: unknown
  content: Fields[] | undefined
}
const openHandsToolCallOf = (event: AgentEvent): AcpToolCall => ({
  id: String(event.tool_call_id),
  title: String(event.title),
  kind: event.tool_kind,
  status: event.status,
  rawInput: (event.raw_input ?? {}) as Fields,
  rawOutput: event.raw_output,
  content: event.content as Fields[] | undefined,
})
const hqAgentToolCallOf = (event: AgentEvent, update: Fields): AcpToolCall => ({
  id: `${event.id.split(':')[0]}:${update?.toolCallId}`,
  title: String(update?.title),
  kind: update?.kind,
  status: update?.status,
  rawInput: (update?.rawInput ?? {}) as Fields,
  rawOutput: update?.rawOutput,
  content: update?.content as Fields[] | undefined,
})
const acpDiffOf = (call: AcpToolCall) => call.content?.find((part) => part?.type === 'diff')
const acpStepOf = (call: AcpToolCall): StoredStep => {
  const { title, rawInput } = call
  const path = pathOf(rawInput?.file_path ?? acpDiffOf(call)?.path)
  if (rawInput?.server && rawInput.tool)
    return {
      type: 'tool',
      name: toolDisplayNameOf(String(rawInput.tool)),
      arguments: JSON.stringify(rawInput.arguments ?? {}),
      result: null,
    }
  if (typeof rawInput?.skill === 'string')
    return { type: 'tool', name: `Skill ${rawInput.skill}`, arguments: String(rawInput.args ?? ''), result: null }
  if (call.kind === 'execute')
    return { type: 'command', command: title, exitCode: null, durationMilliseconds: null, ...keptOutputOf('') }
  if (call.kind === 'edit')
    return {
      type: 'file',
      operation: title.startsWith('Write') ? 'create' : 'edit',
      path,
      added: 0,
      removed: 0,
      diff: [],
    }
  if (call.kind === 'read') return { type: 'file', operation: 'read', path, added: 0, removed: 0, diff: [] }
  return { type: 'tool', name: toolDisplayNameOf(title), arguments: JSON.stringify(rawInput), result: null }
}
const acpToolCallProjectionOf = (call: AcpToolCall): AgentProjection => {
  const { rawOutput } = call
  const output = (rawOutput ?? {}) as Record<string, unknown>
  const contentText = textOf(call.content?.map((part) => part?.content))
  const diff = acpDiffOf(call)
  if (call.status === 'completed' || call.status === 'failed')
    return {
      type: 'observation',
      actionId: call.id,
      step: acpStepOf(call),
      observation: {
        command: call.rawInput?.command,
        content: [
          {
            text:
              typeof rawOutput === 'string'
                ? rawOutput
                : contentText ||
                  textOf(rawOutput) ||
                  String(output.formatted_output ?? '') ||
                  textOf((output.result as Fields)?.content),
          },
        ],
        exit_code: output.exit_code ?? (call.status === 'failed' ? 1 : 0),
        old_content: diff?.oldText ?? diff?.old_text,
        new_content: diff?.newText ?? diff?.new_text,
        is_error: call.status === 'failed',
      },
    }
  return call.status === 'pending' || call.status === 'in_progress'
    ? { type: 'step', step: acpStepOf(call), id: call.id }
    : undefined
}
const acpUpdateProjectionOf = (event: AgentEvent): AgentProjection => {
  const update = event.update as Fields
  const kind = update?.sessionUpdate
  if (kind === 'agent_message') return messageOf(update?.text)
  if (kind === 'agent_thought') {
    const thought = thoughtOf(
      [update?.text],
      typeof update?.durationMilliseconds === 'number' ? update.durationMilliseconds : null,
    )
    return thought && stepOf(thought)
  }
  if (kind === 'tool_call') {
    const call = hqAgentToolCallOf(event, update)
    return { type: 'step', step: acpStepOf(call), id: call.id }
  }
  if (kind === 'tool_call_update') return acpToolCallProjectionOf(hqAgentToolCallOf(event, update))
  if (kind === 'error') return stepOf({ type: 'error', message: String(update?.message ?? 'Unknown error') })
  if (kind === 'session_started' && update?.resumeFailed === true)
    return { type: 'message', body: agentNotices.newSession, kind: 'notice' }
  if (kind === 'turn_end' && update?.stopReason !== 'cancelled')
    return { type: 'turn-end', outcome: update?.stopReason === 'error' ? 'error' : 'finished' }
  return undefined
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

const storedAcpUpdates = [
  'tool_call',
  'tool_call_update',
  'turn_end',
  'error',
  'session_started',
  'config_option_update',
  'agent_message',
  'agent_thought',
]

export const isStoredAgentEvent = (event: AgentEvent) =>
  event.kind === 'ACPUpdate'
    ? storedAcpUpdates.includes(String((event.update as Fields)?.sessionUpdate)) &&
      (event.completed === true || (event.update as Fields)?.sessionUpdate === 'tool_call')
    : event.kind !== 'StreamingDeltaEvent' &&
      !(event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state')

export const streamedTextOf = (event: AgentEvent) => {
  if (event.kind === 'ACPUpdate') {
    const update = event.update as Fields
    const isReasoning = update?.sessionUpdate === 'agent_thought_chunk'
    return isReasoning || update?.sessionUpdate === 'agent_message_chunk'
      ? { text: String((update?.content as Fields)?.text ?? ''), isReasoning }
      : undefined
  }
  if (event.kind !== 'StreamingDeltaEvent') return undefined
  const content = typeof event.content === 'string' ? event.content : ''
  const reasoning = typeof event.reasoning_content === 'string' ? event.reasoning_content : ''
  return content === '' && reasoning !== ''
    ? { text: reasoning, isReasoning: true }
    : { text: content, isReasoning: false }
}

export const recordedLengthOf = (event: AgentEvent, recordedText: string) => {
  const message = (event.action as Fields)?.message
  return recordedText !== '' && typeof message === 'string' && message.startsWith(recordedText)
    ? recordedText.length
    : 0
}

export const streamedTextEventOf = (event: AgentEvent, text: string): AgentEvent => ({
  id: `${event.id}-text`,
  kind: 'MessageEvent',
  timestamp: event.timestamp,
  source: 'agent',
  llm_message: { role: 'assistant', content: [{ type: 'text', text }] },
})

export const agentProjectionOf = (
  event: AgentEvent,
  previousTimestamp: string | null,
  recordedLength = 0,
): AgentProjection => {
  const action = event.action as Fields
  const durationMilliseconds =
    previousTimestamp === null ? null : Date.parse(event.timestamp) - Date.parse(previousTimestamp)
  if (event.kind === 'MessageEvent' && event.source === 'agent')
    return messageOf(textOf((event.llm_message as Fields)?.content))
  if (isFinishEvent(event)) {
    const message = messageOf(String(action?.message ?? '').slice(recordedLength))
    const thought = thoughtOf([event.reasoning_content], durationMilliseconds)
    return message?.type === 'message' && thought ? { ...message, thought } : (message ?? (thought && stepOf(thought)))
  }
  if (event.kind === 'ACPToolCallEvent') return acpToolCallProjectionOf(openHandsToolCallOf(event))
  if (event.kind === 'ACPUpdate') return acpUpdateProjectionOf(event)
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

export const observedProjectionStep = (
  stored: StoredStep,
  { step, observation }: Extract<AgentProjection, { type: 'observation' }>,
  durationMilliseconds: number,
) => {
  const current = step ? { ...step, ...(stored.delegation && { delegation: stored.delegation }) } : stored
  return observedStep(current, observation, durationMilliseconds) ?? (step && current)
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

export const notReadyNoticeOf = (
  { state, failure = null }: { state: string; failure?: string | null },
  isLocalSession: boolean,
) => {
  if (isLocalSession && (state === 'host_offline' || failure === 'no_host')) return agentNotices.machineOffline
  return state === 'host_offline' ? agentNotices.hostOffline : startFailureNoticeOf(failure)
}
