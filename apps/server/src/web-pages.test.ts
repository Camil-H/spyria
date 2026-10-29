import { afterAll, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { createWebPageReader } from './web-pages.ts'

const site = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/moved') return Response.redirect('/docs', 302)
    if (pathname === '/to-another-host') return Response.redirect('http://127.0.0.2/admin', 302)
    if (pathname === '/loop') return Response.redirect('/loop', 302)
    if (pathname === '/latin')
      return new Response(new Uint8Array([0x3c, 0x70, 0x3e, 0xe9, 0x74, 0xe9]), {
        headers: { 'content-type': 'text/html; charset=iso-8859-1' },
      })
    if (pathname === '/zipped')
      return new Response(gzipSync('<h1>Zipped</h1>'), {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      })
    if (pathname === '/large')
      return new Response('x'.repeat(6 * 1024 * 1024), { headers: { 'content-type': 'text/html' } })
    if (pathname === '/report.pdf') return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })
    return new Response(`<h1>Docs</h1><p>${request.headers.get('accept-language')}</p>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  },
})
afterAll(() => site.stop(true))

const siteUrl = `http://127.0.0.1:${site.port}`
const readOnLoopback = createWebPageReader({ isReachable: (address) => address === '127.0.0.1' })
const messageOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: Error) => error.message,
  )

test('a page is read with the member’s languages, following redirects to its final address', async () => {
  expect(await readOnLoopback(`${siteUrl}/moved`, 'fr-FR')).toEqual({
    url: `${siteUrl}/docs`,
    html: '<h1>Docs</h1><p>fr-FR</p>',
  })
})

test('a page is decoded from its character set and its compression', async () => {
  expect((await readOnLoopback(`${siteUrl}/latin`, undefined)).html).toBe('<p>été')
  expect((await readOnLoopback(`${siteUrl}/zipped`, undefined)).html).toBe('<h1>Zipped</h1>')
})

test('a file that is not a page is answered with its address alone', async () => {
  expect(await readOnLoopback(`${siteUrl}/report.pdf`, undefined)).toEqual({ url: `${siteUrl}/report.pdf` })
})

test('an address on the server’s own machine or network is refused, also after a redirect', async () => {
  const notPublic = 'This page is not on the public web, so Spyria does not open it'
  expect(await messageOf(createWebPageReader()(`${siteUrl}/docs`, undefined))).toBe(notPublic)
  expect(await messageOf(createWebPageReader()(`http://localhost:${site.port}/docs`, undefined))).toBe(notPublic)
  expect(await messageOf(readOnLoopback(`${siteUrl}/to-another-host`, undefined))).toBe(notPublic)
})

test('a page over 5 MB, an endless redirect or another scheme is not read', async () => {
  expect(await messageOf(readOnLoopback(`${siteUrl}/large`, undefined))).toBe('This page is over 5 MB')
  expect(await messageOf(readOnLoopback(`${siteUrl}/loop`, undefined))).toBe('This page could not be reached')
  expect(await messageOf(readOnLoopback('file:///etc/passwd', undefined))).toBe('This page could not be reached')
})
