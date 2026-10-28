import { pathOf } from './agent-steps.ts'

export type OpenedPage = Readonly<{ url: string; title: string }>
type Refusal = { refusal: string }

const maximumAddressLength = 2048
const maximumTitleLength = 200
const webAddress = /^https?:\/\//i
const anyScheme = /^[a-z][\w+.-]*:/i
const ipv4Address = /^\d+\.\d+\.\d+\.\d+$/
const localName = /(^|\.)(localhost|local)$/

export const openPageTool = {
  name: 'open_page',
  description:
    "Open a page in the member's Browser panel: a public http or https address, or the path of a file in the project such as an HTML report you wrote. When you build something the member should look at, such as a report or a page, open it with open_page. Addresses on the member's own machine or network, such as localhost or 192.168.x.x, are not opened.",
  inputSchema: {
    type: 'object',
    required: ['address'],
    properties: { address: { type: 'string' }, title: { type: 'string' } },
  },
}
export const pageOpenedText = "The page is open in the member's Browser panel."

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

const addressOf = (address: unknown): string | Refusal => {
  const text = typeof address === 'string' ? address.trim() : ''
  if (text === '') return { refusal: 'Give the address of the page to open' }
  if (text.length > maximumAddressLength)
    return { refusal: `The address is longer than ${maximumAddressLength} characters` }
  if (webAddress.test(text)) {
    if (!URL.canParse(text)) return { refusal: `${text} is not a valid web address` }
    return isOnMembersNetwork(text)
      ? { refusal: `${text} is on the member's own machine or network, so it is not opened` }
      : text
  }
  if (anyScheme.test(text)) return { refusal: 'Only http and https addresses and project files are opened' }
  const path = pathOf(text).replace(/^(\.?\/)+/, '')
  return path === '' || path.split('/').includes('..')
    ? { refusal: 'A project file is opened by its path inside the project' }
    : path
}

export const openedPageOf = (input: unknown): OpenedPage | Refusal => {
  const { address, title } = (input ?? {}) as { address?: unknown; title?: unknown }
  const url = addressOf(address)
  if (typeof url !== 'string') return url
  const trimmedTitle = typeof title === 'string' ? title.trim().slice(0, maximumTitleLength) : ''
  return { url, title: trimmedTitle || url }
}
