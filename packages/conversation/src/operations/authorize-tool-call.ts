import { type MemberId, type MessageId, type ToolApproval, toolNamePartsOf } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'
import {
  guestPrompterOf,
  guestToolRefusalOf,
  needsApproval,
  notApprovedOf,
  toolGatewayUnreachable,
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
type Input = { turn: Turn; toolName: string; serverName: string; toolArguments: unknown; signal: AbortSignal }
type ToolCallPolicy = {
  access: 'allowed' | 'owner_account' | 'not_allowed'
  readOnly: boolean | null
  approval: ToolApproval
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
  { turn, toolName, serverName, toolArguments, signal }: Input,
  { policyOf }: Checks,
): Promise<Authorization> => {
  const { tool } = toolNamePartsOf(toolName)
  const { chat, promptId, ownerId, ownerName } = turn
  const prompterName = turn.prompterName ?? ''
  const guestId = guestPrompterOf(turn)
  const policy = await policyOf(turn.prompterId ?? ownerId).catch(() => null)
  if (!policy) return { refusal: toolGatewayUnreachable, readOnly: null, ...notNeeded }
  const { access, readOnly, approval } = policy
  if (access !== 'allowed')
    return {
      refusal: guestToolRefusalOf(access, { ownerName, prompterName, server: serverName }),
      readOnly,
      ...notNeeded,
    }
  if (!needsApproval(approval, guestId !== null)) return { readOnly, ...notNeeded }
  const decided = await requestToolApproval(dependencies, {
    chat,
    promptId,
    ownerId,
    signal,
    approval: { server: serverName, tool, arguments: JSON.stringify(toolArguments ?? {}), prompterName, ownerName },
  })
  return { readOnly, ...decided, ...(decided.decision !== 'approved' && { refusal: notApprovedOf(ownerName) }) }
}
