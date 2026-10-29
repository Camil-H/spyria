import { type LookupAddress, lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import {
  isPrivateNetworkAddress,
  maximumWebPageBytes,
  type WebPage,
  WebPageNotPublic,
  WebPageTooLarge,
  WebPageUnreachable,
} from '@spyria/conversation/server'

type Reached = { response: IncomingMessage; body: () => Promise<Uint8Array> }
type LookupAnswer = (error: Error | null, address: string | LookupAddress[], family?: number) => void

const maximumRedirects = 5
const timeoutMilliseconds = 15_000
const browserUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const htmlTypes = /^(text\/html|application\/xhtml\+xml)\b/i
const charsetInHeader = /charset=["']?([\w-]+)/i
const charsetInMarkup = /<meta[^>]+charset=["']?([\w-]+)/i
const decompressorByEncoding: Record<string, (body: Uint8Array, options: { maxOutputLength: number }) => Buffer> = {
  gzip: gunzipSync,
  'x-gzip': gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
}

const publicLookup =
  (isReachable: (address: string) => boolean) => (hostname: string, options: { all?: boolean }, answer: LookupAnswer) =>
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return answer(error, [])
      if (addresses.length === 0 || !addresses.every(({ address }) => isReachable(address)))
        return answer(new WebPageNotPublic(), [])
      const [first] = addresses
      if (options.all) return answer(null, addresses)
      answer(null, first?.address ?? '', first?.family)
    })

const reach = (
  url: URL,
  headers: Record<string, string>,
  isReachable: (address: string) => boolean,
  signal: AbortSignal,
) =>
  new Promise<Reached>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !isReachable(host)) return reject(new WebPageNotPublic())
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { headers, signal, lookup: publicLookup(isReachable) as never },
      (response) =>
        resolve({
          response,
          body: async () => {
            const chunks: Uint8Array[] = []
            let size = 0
            for await (const chunk of response as AsyncIterable<Uint8Array>) {
              size += chunk.length
              if (size > maximumWebPageBytes) {
                response.destroy()
                throw new WebPageTooLarge()
              }
              chunks.push(chunk)
            }
            return Buffer.concat(chunks)
          },
        }),
    )
    request.on('error', reject)
    request.end()
  })

const decompressed = (body: Uint8Array, encoding: string | undefined) => {
  const decompress = decompressorByEncoding[(encoding ?? '').trim().toLowerCase()]
  if (!decompress) return body
  try {
    return decompress(body, { maxOutputLength: maximumWebPageBytes })
  } catch {
    throw new WebPageTooLarge()
  }
}

const textOf = (body: Uint8Array, contentType: string) => {
  const charset =
    charsetInHeader.exec(contentType)?.[1] ??
    charsetInMarkup.exec(new TextDecoder().decode(body.subarray(0, 1024)))?.[1] ??
    'utf-8'
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder().decode(body)
  }
}

const isWebUrl = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:'

export const createWebPageReader =
  ({ isReachable = (address: string) => !isPrivateNetworkAddress(address) } = {}) =>
  async (address: string, acceptLanguage: string | undefined): Promise<WebPage> => {
    const signal = AbortSignal.timeout(timeoutMilliseconds)
    const headers = {
      'user-agent': browserUserAgent,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      ...(acceptLanguage && { 'accept-language': acceptLanguage }),
    }
    let url = URL.parse(address)
    for (let redirects = 0; url && isWebUrl(url) && redirects <= maximumRedirects; redirects++) {
      const { response, body } = await reach(url, headers, isReachable, signal).catch((error: unknown) => {
        throw error instanceof WebPageNotPublic ? error : new WebPageUnreachable()
      })
      const location = response.headers.location
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.destroy()
        url = URL.parse(location, url)
        continue
      }
      const contentType = response.headers['content-type'] ?? ''
      if (!htmlTypes.test(contentType)) {
        response.destroy()
        return { url: url.href }
      }
      const content = await body().catch((error: unknown) => {
        throw error instanceof WebPageTooLarge ? error : new WebPageUnreachable()
      })
      return { url: url.href, html: textOf(decompressed(content, response.headers['content-encoding']), contentType) }
    }
    throw new WebPageUnreachable()
  }
