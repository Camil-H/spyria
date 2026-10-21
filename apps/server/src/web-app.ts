import { join } from 'node:path'

const serverPaths = /^\/(api|auth|host|health|mcp|test|fake-llm|gateway-oauth)(\/|$)/
const hashedAssetsPath = '/assets/'
const immutable = 'public, max-age=31536000, immutable'

export const webAppResponse = async (webDist: string, request: Request) => {
  const { pathname } = new URL(request.url)
  if ((request.method !== 'GET' && request.method !== 'HEAD') || serverPaths.test(pathname)) return undefined
  const isHashedAsset = pathname.startsWith(hashedAssetsPath)
  const file = Bun.file(join(webDist, pathname))
  if (await file.exists())
    return new Response(file, { headers: { 'cache-control': isHashedAsset ? immutable : 'no-cache' } })
  if (isHashedAsset) return undefined
  return new Response(Bun.file(join(webDist, 'index.html')), { headers: { 'cache-control': 'no-cache' } })
}
