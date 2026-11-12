import { type MemberId, type ToolApproval, toolApprovals, toolNamePartsOf } from '@spyria/kernel'

export type ToolCallFailure = 'needs_connection' | 'not_allowed' | 'unavailable'
type Names = { memberName: string; server: string; isReconnect: boolean }
export type ToolRefusal = 'not_granted' | 'not_shared'

export const toolApprovalWindowMilliseconds = 300_000
export const spyriaToolTimeoutSeconds = 330
export const notApprovedOf = (answererName: string) => `${answererName} did not approve this call`
export const toolGatewayUnreachable = 'The tool gateway is unreachable, try again shortly'
const connectionNotice = / needs to (re)?connect (\S+)$/
const guestMethods = ['initialize', 'ping', 'tools/list', 'tools/call']

export const needsApproval = (approval: ToolApproval, isGuestPrompt: boolean) =>
  approval === toolApprovals.always || (approval === toolApprovals.guest && isGuestPrompt)

export const guestPrompterOf = ({ ownerId, prompterId }: { ownerId: MemberId; prompterId: MemberId | null }) =>
  prompterId !== ownerId ? prompterId : null

export const isGuestToolMethod = (rpc: unknown) => {
  const { id, method } = (rpc ?? {}) as { id?: unknown; method?: unknown }
  const isNotification = id === undefined && String(method).startsWith('notifications/')
  return typeof rpc === 'object' && (guestMethods.includes(String(method)) || isNotification)
}

export const toolDisplayNameOf = (prefixedName: string) => {
  const toolName = prefixedName.replace(/^mcp__(spyria|tools|router|github)__/, '')
  const { server, tool } = toolNamePartsOf(toolName)
  return toolName.includes('-') ? `${tool} (${server})` : toolName
}

export const toolCallFailureOf = (text: string): ToolCallFailure | undefined => {
  if (text.startsWith('Authentication required for ') || /request failed with status 401\b/.test(text))
    return 'needs_connection'
  if (/is not allowed for virtual key/.test(text)) return 'not_allowed'
  if (text.includes('failed to establish ephemeral MCP connection')) return 'unavailable'
  return undefined
}

export const toolCallNoticeOf = (failure: ToolCallFailure, { memberName, server, isReconnect }: Names) =>
  ({
    needs_connection: `${memberName} needs to ${isReconnect ? 'reconnect' : 'connect'} ${server}`,
    not_allowed: `${server} isn't available for this chat`,
    unavailable: `${server} is unavailable, try again shortly`,
  })[failure]

export const toolNotGrantedOf = ({ memberName, server, tool }: { memberName: string; server: string; tool: string }) =>
  `${memberName}'s access to ${server} does not include ${tool} in this chat`

export const toolRefusalOf = (
  refusal: ToolRefusal,
  { prompterName, server, tool }: { prompterName: string; server: string; tool: string },
) =>
  refusal === 'not_granted'
    ? toolNotGrantedOf({ memberName: prompterName, server, tool })
    : `${server} isn't available on ${prompterName}'s prompts in this chat`

export const toolConnectionOf = (result: string) => {
  const [, reconnect, server] = result.match(connectionNotice) ?? []
  return server ? { server, isReconnect: reconnect !== undefined } : undefined
}
