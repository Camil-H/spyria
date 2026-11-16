export type BrowserPage = Readonly<{ url: string; title: string }>
export type BrowserState =
  | Readonly<{ state: 'connecting' }>
  | Readonly<{ state: 'starting' }>
  | Readonly<{ state: 'disconnected' }>
  | Readonly<{ state: 'running'; canBrowse: boolean }>
  | Readonly<{ state: 'stopped' | 'unavailable'; reason: string }>
export type BrowserMessage =
  | (BrowserState & { type: 'state' })
  | Readonly<{ type: 'frame'; data: string; width: number; height: number }>
  | Readonly<{ type: 'page'; url: string; title: string }>
  | Readonly<{ type: 'notice'; text: string }>
  | Readonly<{ type: 'file_chooser'; multiple: boolean }>
  | Readonly<{ type: 'download'; name: string; data: string }>
type Size = Readonly<{ width: number; height: number }>

const searchUrl = 'https://www.bing.com/search?q='
const webAddress = /^https?:\/\//i
const hostAddress = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i
const localAddress = /^(localhost|127\.0\.0\.1)([:/?#]|$)/i
const htmlFile = /\.(html?|svg)$/i
const mouseButtons = ['left', 'middle', 'right'] as const
export const maximumUploadBytes = 25 * 1024 * 1024

export const isWebAddress = (url: string) => webAddress.test(url)

export const isHtmlFile = (path: string) => htmlFile.test(path)

export const browsedPageOf = (typed: string): BrowserPage | undefined => {
  const text = typed.trim()
  if (text === '') return undefined
  if (isWebAddress(text) && URL.canParse(text)) return { url: text, title: text }
  if (hostAddress.test(text)) {
    const url = `${localAddress.test(text) ? 'http' : 'https'}://${text}`
    return { url, title: text }
  }
  return { url: `${searchUrl}${encodeURIComponent(text)}`, title: text }
}

export const pagePointOf = (point: { x: number; y: number }, shown: Size, page: Size) => ({
  x: shown.width > 0 ? Math.round((point.x * page.width) / shown.width) : 0,
  y: shown.height > 0 ? Math.round((point.y * page.height) / shown.height) : 0,
})

export const mouseButtonOf = (button: number) => mouseButtons[button] ?? 'left'

export const pageKeyOf = (key: string, isMac: boolean) => (isMac && key === 'Meta' ? 'Control' : key)

export const stateTextOf = (state: BrowserState) => {
  if (state.state === 'connecting' || state.state === 'starting') return 'Starting your browser…'
  if (state.state === 'disconnected') return 'The connection to your browser was lost'
  if (state.state === 'running') return undefined
  if (state.reason === 'idle') return 'Your browser stopped after 10 minutes without use'
  if (state.reason === 'stopped') return 'Your browser stopped'
  return state.reason
}
