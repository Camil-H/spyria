export type BrowserPage = Readonly<{ url: string; title: string }>

const searchUrl = 'https://www.bing.com/search?q='
const webAddress = /^https?:\/\//i
const hostAddress = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i
const localAddress = /^(localhost|127\.0\.0\.1)([:/?#]|$)/i
const htmlFile = /\.(html?|svg)$/i

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
