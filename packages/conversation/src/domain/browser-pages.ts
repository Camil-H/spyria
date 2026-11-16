import { pathOf } from './agent-steps.ts'

export type OpenedPage = Readonly<{ url: string; title: string }>
type Refusal = { refusal: string }

const maximumAddressLength = 2048
const maximumTitleLength = 200
const webAddress = /^https?:\/\//i
const anyScheme = /^[a-z][\w+.-]*:/i

export const openPageTool = {
  name: 'open_page',
  description:
    'Open a web address in the browser of the member who prompted you, with their own sign-ins, where they watch it live in the Browser tab; http://localhost:<port> reaches the app you run in this runtime. Or open the path of a file in the project, such as an HTML report you wrote, for everyone in the chat. Then read and act on a web page with the browser_ tools.',
  inputSchema: {
    type: 'object',
    required: ['address'],
    properties: { address: { type: 'string' }, title: { type: 'string' } },
  },
}
export const pageOpenedText = "The file is open in the chat's Browser tab."
export const isWebPage = (page: OpenedPage) => webAddress.test(page.url)

const addressOf = (address: unknown): string | Refusal => {
  const text = typeof address === 'string' ? address.trim() : ''
  if (text === '') return { refusal: 'Give the address of the page to open' }
  if (text.length > maximumAddressLength)
    return { refusal: `The address is longer than ${maximumAddressLength} characters` }
  if (webAddress.test(text)) {
    if (!URL.canParse(text)) return { refusal: `${text} is not a valid web address` }
    return text
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
