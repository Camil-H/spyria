import { type MemberId, toolNamePartsOf } from '@hq/kernel'

export type ToolCallFailure = 'needs_connection' | 'not_allowed' | 'unavailable'
type Names = { ownerName: string; server: string; isReconnect: boolean }

export const toolApprovalWindowMilliseconds = 300_000
export const hqToolTimeoutSeconds = 330
export const notApprovedOf = (ownerName: string) => `${ownerName} did not approve this call`
export const toolGatewayUnreachable = 'The tool gateway is unreachable, try again shortly'
const connectionNotice = / needs to (re)?connect (\S+)$/
const guestMethods = ['initialize', 'ping', 'tools/list', 'tools/call']

export const guestPrompterOf = ({ ownerId, prompterId }: { ownerId: MemberId; prompterId: MemberId | null }) =>
  prompterId !== ownerId ? prompterId : null

export const isGuestToolMethod = (rpc: unknown) => {
  const { id, method } = (rpc ?? {}) as { id?: unknown; method?: unknown }
  const isNotification = id === undefined && String(method).startsWith('notifications/')
  return typeof rpc === 'object' && (guestMethods.includes(String(method)) || isNotification)
}

export const toolDisplayNameOf = (prefixedName: string) => {
  const toolName = prefixedName.replace(/^mcp__(hq|router)__/, '')
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

export const toolCallNoticeOf = (failure: ToolCallFailure, { ownerName, server, isReconnect }: Names) =>
  ({
    needs_connection: `${ownerName} needs to ${isReconnect ? 'reconnect' : 'connect'} ${server}`,
    not_allowed: `${server} isn't available for this chat`,
    unavailable: `${server} is unavailable, try again shortly`,
  })[failure]

export const guestToolRefusalOf = (
  refusal: 'personal' | 'not_allowed',
  { ownerName, prompterName, server }: { ownerName: string; prompterName: string; server: string },
) =>
  refusal === 'personal'
    ? `${server} is ${ownerName}'s personal connection, used only on ${ownerName}'s own prompts`
    : `${server} isn't available on ${prompterName}'s prompts in this chat`

export const toolConnectionOf = (result: string) => {
  const [, reconnect, server] = result.match(connectionNotice) ?? []
  return server ? { server, isReconnect: reconnect !== undefined } : undefined
}
