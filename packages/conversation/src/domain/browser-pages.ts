import type { AgentEvent } from './agent-events.ts'
import { type Fields, pathOf } from './agent-steps.ts'

export type OpenedPage = Readonly<{ url: string; title: string }>

export const openPageToolName = 'open_page'
const maximumAddressLength = 2048
const maximumTitleLength = 200
const webAddress = /^https?:\/\//i
const anyScheme = /^[a-z][\w+.-]*:/i
const ipv4Address = /^\d+\.\d+\.\d+\.\d+$/
const localName = /(^|\.)(localhost|local)$/

const isPrivateIpv4 = ([first = 0, second = 0]: readonly number[]) =>
  first === 0 ||
  first === 10 ||
  first === 127 ||
  (first === 100 && second >= 64 && second < 128) ||
  (first === 169 && second === 254) ||
  (first === 172 && second >= 16 && second < 32) ||
  (first === 192 && second === 168)

const ipv6GroupsOf = (address: string) => {
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16)))
  const [head = '', tail] = address.split('::')
  if (tail === undefined) return groupsOf(head)
  const [headGroups, tailGroups] = [groupsOf(head), groupsOf(tail)]
  return [...headGroups, ...Array<number>(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups]
}

const isPrivateIpv6 = (address: string) => {
  const groups = ipv6GroupsOf(address)
  const [first = 0, , , , , sixth = 0, seventh = 0] = groups
  const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && sixth === 0xffff
  if (isMappedIpv4) return isPrivateIpv4([seventh >> 8, seventh & 0xff])
  return groups.slice(0, 7).every((group) => group === 0) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

const isOnMembersNetwork = (url: string) => {
  const host = new URL(url).hostname.replace(/\.$/, '')
  if (host.startsWith('[')) return isPrivateIpv6(host.slice(1, -1))
  if (ipv4Address.test(host)) return isPrivateIpv4(host.split('.').map(Number))
  return !host.includes('.') || localName.test(host)
}

const addressOf = (address: unknown) => {
  const text = typeof address === 'string' ? address.trim() : ''
  if (text === '' || text.length > maximumAddressLength) return undefined
  if (webAddress.test(text)) return URL.canParse(text) && !isOnMembersNetwork(text) ? text : undefined
  if (anyScheme.test(text)) return undefined
  const path = pathOf(text).replace(/^(\.?\/)+/, '')
  return path === '' || path.split('/').includes('..') ? undefined : path
}

export const openedPageOf = (event: AgentEvent): OpenedPage | undefined => {
  const update = event.update as Fields
  if (event.kind !== 'ACPUpdate' || update?.sessionUpdate !== 'tool_call' || update.title !== openPageToolName)
    return undefined
  const input = update.rawInput as Fields
  const url = addressOf(input?.address)
  if (!url) return undefined
  const title = typeof input?.title === 'string' ? input.title.trim().slice(0, maximumTitleLength) : ''
  return { url, title: title || url }
}
