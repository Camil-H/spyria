export type BrowserPage = Readonly<{ url: string; title: string }>
export type WebPage = Readonly<{ url: string; html?: string }>

const searchUrl = 'https://www.bing.com/search?q='
const bingClickPath = /^https:\/\/www\.bing\.com\/ck\/a\b/i
const webAddress = /^https?:\/\//i
const hostAddress = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i
const localAddress = /^(localhost|127\.0\.0\.1)([:/?#]|$)/i
const htmlFile = /\.(html?|svg)$/i
const headTag = /<head(\s[^>]*)?>/i
const doctype = /^\s*<!doctype[^>]*>/i
const baseHref = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i

export const isWebAddress = (url: string) => webAddress.test(url)

export const isHtmlFile = (path: string) => htmlFile.test(path)

export const isOnMembersMachine = (url: string) => isWebAddress(url) && localAddress.test(url.replace(webAddress, ''))

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

const decodedBase64Url = (encoded: string) => {
  try {
    return atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
  } catch {
    return ''
  }
}

export const followedPageOf = (address: unknown): BrowserPage | undefined => {
  const url = typeof address === 'string' && URL.parse(address)
  if (!url || !isWebAddress(url.href)) return undefined
  const target = bingClickPath.test(url.href) ? (url.searchParams.get('u') ?? '') : ''
  const unwrapped = target.startsWith('a1') ? decodedBase64Url(target.slice(2)) : ''
  const href = isWebAddress(unwrapped) && URL.canParse(unwrapped) ? unwrapped : url.href
  return { url: href, title: href }
}

const attributeOf = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

export const framedHtmlOf = ({ url, html = '' }: WebPage) => {
  const ownBase = baseHref.exec(html)?.[1]
  const base = `<base href="${attributeOf(URL.parse(ownBase ?? '', url)?.href ?? url)}">`
  if (headTag.test(html)) return html.replace(headTag, (head) => `${head}${base}`)
  const declared = doctype.exec(html)?.[0] ?? ''
  return `${declared}${base}${html.slice(declared.length)}`
}
