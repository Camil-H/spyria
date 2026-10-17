export type ToolCallFailure = 'needs_connection' | 'not_allowed' | 'unavailable'
type Names = { ownerName: string; server: string; isReconnect: boolean }

export const toolGatewayUnreachable = 'The tool gateway is unreachable, try again shortly'
const connectionNotice = / needs to (re)?connect (\S+)$/

export const toolServerOf = (toolName: string) => toolName.split('-')[0] ?? toolName

export const toolDisplayNameOf = (prefixedName: string) => {
  const toolName = prefixedName.replace(/^mcp__(hq|router)__/, '')
  const separator = toolName.indexOf('-')
  return separator === -1 ? toolName : `${toolName.slice(separator + 1)} (${toolName.slice(0, separator)})`
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
