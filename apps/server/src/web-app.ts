import { join } from 'node:path'

const serverPaths = /^\/(api|auth|host|health|mcp|test|fake-llm|gateway-oauth)(\/|$)/
const hashedAssetsPath = '/assets/'
const immutable = 'public, max-age=31536000, immutable'
const precompressedVariants = [
  { encoding: 'br', extension: '.br' },
  { encoding: 'gzip', extension: '.gz' },
]

const acceptedEncodingsOf = (request: Request) =>
  new Set(
    (request.headers.get('accept-encoding') ?? '')
      .split(',')
      .map((part) => part.split(';').map((token) => token.trim().toLowerCase()))
      .filter(([, ...parameters]) => !parameters.some((parameter) => /^q=0(\.0*)?$/.test(parameter)))
      .map(([encoding]) => encoding),
  )

const fileResponse = async (request: Request, path: string, cacheControl: string) => {
  const file = Bun.file(path)
  const headers = { 'cache-control': cacheControl, vary: 'accept-encoding' }
  const acceptedEncodings = request.headers.has('range') ? new Set() : acceptedEncodingsOf(request)
  for (const { encoding, extension } of precompressedVariants) {
    const variant = Bun.file(`${path}${extension}`)
    if (acceptedEncodings.has(encoding) && (await variant.exists()))
      return new Response(variant, { headers: { ...headers, 'content-type': file.type, 'content-encoding': encoding } })
  }
  return new Response(file, { headers })
}

export const webAppResponse = async (webDist: string, request: Request) => {
  const { pathname } = new URL(request.url)
  if ((request.method !== 'GET' && request.method !== 'HEAD') || serverPaths.test(pathname)) return undefined
  const isHashedAsset = pathname.startsWith(hashedAssetsPath)
  const path = join(webDist, pathname)
  if (await Bun.file(path).exists()) return fileResponse(request, path, isHashedAsset ? immutable : 'no-cache')
  if (isHashedAsset) return undefined
  return fileResponse(request, join(webDist, 'index.html'), 'no-cache')
}
