import type { MemberId, MessageId, ToolApproval } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'
import {
  guestPrompterOf,
  needsApproval,
  notApprovedOf,
  type ToolRefusal,
  toolGatewayUnreachable,
  toolRefusalOf,
} from '../domain/tool-calls.ts'
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
type Input = { turn: Turn; tool: string; serverName: string; toolArguments: unknown; signal: AbortSignal }
type ToolCallPolicy = {
  access: 'allowed' | ToolRefusal
  readOnly: boolean | null
  approval: ToolApproval
  answerer: 'prompter' | 'owner'
}
type Checks = { policyOf: (prompterId: MemberId) => Promise<ToolCallPolicy> }
type Authorization = {
  refusal?: string
  readOnly: boolean | null
  decision: ToolCallDecision
  decidedBy: MemberId | null
}

const notNeeded = { decision: 'not_needed', decidedBy: null } as const

export const authorizeToolCall = async (
  dependencies: AgentDependencies,
  { turn, tool, serverName, toolArguments, signal }: Input,
  { policyOf }: Checks,
): Promise<Authorization> => {
  const { chat, promptId, ownerId, ownerName } = turn
  const prompterId = turn.prompterId ?? ownerId
  const prompterName = turn.prompterName ?? ownerName
  const policy = await policyOf(prompterId).catch(() => null)
  if (!policy) return { refusal: toolGatewayUnreachable, readOnly: null, ...notNeeded }
  const { access, readOnly, approval, answerer } = policy
  if (access !== 'allowed')
    return { refusal: toolRefusalOf(access, { prompterName, server: serverName, tool }), readOnly: null, ...notNeeded }
  if (!needsApproval(approval, guestPrompterOf(turn) !== null)) return { readOnly, ...notNeeded }
  const [answererId, answererName] = answerer === 'owner' ? [ownerId, ownerName] : [prompterId, prompterName]
  const decided = await requestToolApproval(dependencies, {
    chat,
    promptId,
    answererId,
    signal,
    approval: {
      server: serverName,
      tool,
      arguments: JSON.stringify(toolArguments ?? {}),
      prompterName,
      answererId,
      answererName,
    },
  })
  return { readOnly, ...decided, ...(decided.decision !== 'approved' && { refusal: notApprovedOf(answererName) }) }
}
