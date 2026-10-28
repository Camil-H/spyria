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
export type TurnOutcome = 'finished' | 'error'
type AgentProjection =
  | { type: 'message'; body: string; kind?: 'notice'; thought?: ThoughtStep }
  | { type: 'step'; step: StoredStep; id?: string }
  | { type: 'observation'; actionId: string; observation: Fields; step?: StoredStep }
  | { type: 'turn-end'; outcome: TurnOutcome }
  | undefined

export const agentNotices = {
  noHost: 'No runtime host is available',
  couldNotStart: 'The agent could not start',
  imageNotBuilt: "Spyria's runtime image is not built: run bun run agent:build",
  stoppedWithError: 'The agent stopped with an error',
  noReply: 'The agent finished without a reply',
  hostOffline: 'The runtime host is offline',
  machineOffline: 'Your machine is offline',
  stoppedEarly: 'The agent stopped before finishing',
  noResponse: 'The agent did not respond',
  newSession: 'The agent started a new session; it does not remember earlier messages',
}
export const setupFailedNoticeOf = (exitCode: unknown, output: unknown) =>
  `The setup script .spyria/setup.sh failed with exit code ${exitCode}; the session started anyway.\n${output}`
export const unavailableNotices = [
  agentNotices.noHost,
  agentNotices.couldNotStart,
  agentNotices.imageNotBuilt,
  agentNotices.hostOffline,
  agentNotices.machineOffline,
]
export const waitingNotices = [...unavailableNotices, agentNotices.newSession]
export const waitingPromptLifetimeMilliseconds = 60 * 60_000
export const expiredPromptNotice =
  'Not sent: it waited more than an hour for the agent. Send it again if it still applies'
export const hasOutlivedWait = (prompt: { createdAt: Date }, now: number) =>
  now - prompt.createdAt.getTime() >= waitingPromptLifetimeMilliseconds
export const stoppedByPrefix = 'Stopped by '
export const stoppedByNoticeOf = (memberName: string) => `${stoppedByPrefix}${memberName}`
export const silentTurnMilliseconds = 10 * 60_000
export const agentSweepIntervalMilliseconds = 60_000
export const agentJobTypes = {
  prompt: 'agent.prompt',
  startSession: 'agent.start-session',
  interrupt: 'agent.interrupt',
  restartSession: 'agent.restart-session',
  sweep: 'agent.sweep',
} as const

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

type AcpToolCall = {
  id: string
  title: string
  kind: unknown
  status: unknown
  rawInput: Fields
  rawOutput: unknown
  content: Fields[] | undefined
}
const spyriaAgentToolCallOf = (event: AgentEvent, update: Fields): AcpToolCall => ({
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
  const path = pathOf(rawInput?.file_path ?? rawInput?.path ?? acpDiffOf(call)?.path)
  if (rawInput?.server && rawInput.tool)
    return {
      type: 'tool',
      name: toolDisplayNameOf(String(rawInput.tool)),
      arguments: JSON.stringify(rawInput.arguments ?? {}),
      result: null,
    }
  if (typeof rawInput?.subagent_type === 'string')
    return { type: 'tool', name: 'Task', arguments: JSON.stringify(rawInput), result: null }
  if (typeof rawInput?.skill === 'string')
    return { type: 'tool', name: `Skill ${rawInput.skill}`, arguments: String(rawInput.args ?? ''), result: null }
  if (call.kind === 'execute')
    return { type: 'command', command: title, exitCode: null, durationMilliseconds: null, ...keptOutputOf('') }
  if (call.kind === 'edit')
    return {
      type: 'file',
      operation: /^write/i.test(title) ? 'create' : 'edit',
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
        old_content: diff?.oldText,
        new_content: diff?.newText,
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
    const call = spyriaAgentToolCallOf(event, update)
    return { type: 'step', step: acpStepOf(call), id: call.id }
  }
  if (kind === 'tool_call_update') return acpToolCallProjectionOf(spyriaAgentToolCallOf(event, update))
  if (kind === 'error') return stepOf({ type: 'error', message: String(update?.message ?? 'Unknown error') })
  if (kind === 'question_answered' || kind === 'question_closed') {
    const { sessionUpdate: _, reason, ...question } = update as Record<string, unknown>
    return stepOf({
      type: 'question',
      ...question,
      ...(typeof reason === 'string' && { closed: reason }),
    } as StoredStep)
  }
  if (kind === 'setup_failed')
    return { type: 'message', body: setupFailedNoticeOf(update?.exitCode, update?.output), kind: 'notice' }
  if (kind === 'session_started' && update?.resumeFailed === true)
    return { type: 'message', body: agentNotices.newSession, kind: 'notice' }
  if (kind === 'turn_end' && update?.stopReason !== 'cancelled')
    return { type: 'turn-end', outcome: update?.stopReason === 'error' ? 'error' : 'finished' }
  return undefined
}

export const toolCallIdOf = (event: AgentEvent) => {
  const update = event.update as Fields
  return event.kind === 'ACPUpdate' && String(update?.sessionUpdate).startsWith('tool_call')
    ? spyriaAgentToolCallOf(event, update).id
    : undefined
}

export const subagentDelegationOf = (
  event: AgentEvent,
  replies: readonly { id: string; step: StoredStep | null }[],
): StepDelegation | undefined => {
  const callId = toolCallIdOf(event)
  const host =
    callId &&
    replies.findLast(
      ({ id, step }) => step?.type === 'tool' && step.name === 'Task' && step.result === null && id !== callId,
    )
  return host ? { id: host.id, model: '', modelName: '', task: '' } : undefined
}

const storedAcpUpdates = [
  'tool_call',
  'tool_call_update',
  'turn_end',
  'error',
  'session_started',
  'setup_failed',
  'config_option_update',
  'agent_message',
  'agent_thought',
  'question_answered',
  'question_closed',
]

export const isApprovalQuestion = (event: AgentEvent) => {
  const update = event.update as Fields
  return update?.kind === 'approval' && String(update.sessionUpdate).startsWith('question')
}

export const isStoredAgentEvent = (event: AgentEvent) =>
  event.kind === 'ACPUpdate' &&
  storedAcpUpdates.includes(String((event.update as Fields)?.sessionUpdate)) &&
  (event.completed === true || (event.update as Fields)?.sessionUpdate === 'tool_call') &&
  !isApprovalQuestion(event)

const authRequiredCode = -32000
export const isAuthRequiredError = (event: AgentEvent) => {
  const update = event.update as Fields
  return update?.sessionUpdate === 'error' && update.code === authRequiredCode
}

export const turnEndPromptIdOf = (event: AgentEvent) => {
  const update = event.update as Fields
  return update?.sessionUpdate === 'turn_end' && typeof update.promptId === 'string' ? update.promptId : undefined
}

export const streamedTextOf = (event: AgentEvent) => {
  const update = event.update as Fields
  const isReasoning = update?.sessionUpdate === 'agent_thought_chunk'
  return event.kind === 'ACPUpdate' && (isReasoning || update?.sessionUpdate === 'agent_message_chunk')
    ? { text: String((update?.content as Fields)?.text ?? ''), isReasoning }
    : undefined
}

export const agentProjectionOf = (event: AgentEvent): AgentProjection =>
  event.kind === 'ACPUpdate' ? acpUpdateProjectionOf(event) : undefined

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

const acpEndStatuses: Record<string, string> = { cancelled: 'paused', error: 'error' }
export const executionStatusOf = (event: AgentEvent) => {
  const update = event.update as Fields
  if (event.kind !== 'ACPUpdate') return undefined
  if (update?.sessionUpdate === 'error') return 'error'
  return update?.sessionUpdate === 'turn_end' ? (acpEndStatuses[String(update.stopReason)] ?? 'finished') : undefined
}

export const turnEndNoticeOf = (outcome: TurnOutcome, hasReply: boolean) =>
  outcome !== 'finished' ? agentNotices.stoppedWithError : hasReply ? undefined : agentNotices.noReply

export const reopenedTurnOutcomeOf = (executionStatus: string): TurnOutcome | undefined => {
  if (executionStatus === 'running') return undefined
  return executionStatus === 'error' ? 'error' : 'finished'
}

export const startFailureNoticeOf = (failure: string | null) => {
  if (failure === 'no_image') return agentNotices.imageNotBuilt
  return failure === 'no_host' || failure === 'no_capacity' ? agentNotices.noHost : agentNotices.couldNotStart
}

export const notReadyNoticeOf = (
  { state, failure = null }: { state: string; failure?: string | null },
  isLocalSession: boolean,
) => {
  if (isLocalSession && (state === 'host_offline' || failure === 'no_host')) return agentNotices.machineOffline
  return state === 'host_offline' ? agentNotices.hostOffline : startFailureNoticeOf(failure)
}
