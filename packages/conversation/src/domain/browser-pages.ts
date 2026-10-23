import type { AgentEvent } from './agent-events.ts'
import { type Fields, pathOf } from './agent-steps.ts'

export type OpenedPage = Readonly<{ url: string; title: string }>

export const openPageToolName = 'open_page'
const maximumAddressLength = 2048
const maximumTitleLength = 200
const webAddress = /^https?:\/\//i
const anyScheme = /^[a-z][\w+.-]*:/i

const addressOf = (address: unknown) => {
  const text = typeof address === 'string' ? address.trim() : ''
  if (text === '' || text.length > maximumAddressLength) return undefined
  if (webAddress.test(text)) return URL.canParse(text) ? text : undefined
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
