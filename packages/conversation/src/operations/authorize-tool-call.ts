import { type MemberId, type MessageId, toolNamePartsOf } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'
import { guestPrompterOf, guestToolRefusalOf, notApprovedOf, toolGatewayUnreachable } from '../domain/tool-calls.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { requestToolApproval } from './request-tool-approval.ts'

type Turn = {
  chat: AgentChat
  promptId: MessageId | null
  ownerId: MemberId
  prompterId: MemberId | null
  ownerName: string
  prompterName: string | null
}
type Input = { turn: Turn; toolName: string; toolArguments: unknown; signal: AbortSignal }
type Checks = {
  accessOf: (prompterId: MemberId) => Promise<'allowed' | 'personal' | 'not_allowed'>
  isReadOnly: () => Promise<boolean>
}
type Authorization = {
  refusal?: string
  readOnly: boolean | null
  decision: ToolCallDecision
  decidedBy: MemberId | null
}

const notNeeded = { decision: 'not_needed', decidedBy: null } as const

export const authorizeToolCall = async (
  dependencies: AgentDependencies,
  { turn, toolName, toolArguments, signal }: Input,
  { accessOf, isReadOnly }: Checks,
): Promise<Authorization> => {
  const { server, tool } = toolNamePartsOf(toolName)
  const { chat, promptId, ownerId, ownerName } = turn
  const prompterName = turn.prompterName ?? ''
  const guestId = guestPrompterOf(turn)
  const access = await accessOf(turn.prompterId ?? ownerId).catch(() => null)
  if (!access) return { refusal: toolGatewayUnreachable, readOnly: null, ...notNeeded }
  if (access !== 'allowed')
    return { refusal: guestToolRefusalOf(access, { ownerName, prompterName, server }), readOnly: null, ...notNeeded }
  const readOnly = await isReadOnly()
  if (!guestId || readOnly) return { readOnly, ...notNeeded }
  const decided = await requestToolApproval(dependencies, {
    chat,
    promptId,
    ownerId,
    signal,
    approval: { server, tool, arguments: JSON.stringify(toolArguments ?? {}), prompterName, ownerName },
  })
  return { readOnly, ...decided, ...(decided.decision !== 'approved' && { refusal: notApprovedOf(ownerName) }) }
}
