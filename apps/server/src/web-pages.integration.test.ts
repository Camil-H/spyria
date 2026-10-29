import { afterAll, expect, test } from 'bun:test'
import { acme, alice, openSharedTestApp, sessionTokenOf } from './testing/testing.ts'

const { app, database } = await openSharedTestApp()

let reachedRequests = 0
const serverNetworkSite = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => {
    reachedRequests++
    return new Response('<h1>Admin</h1>', { headers: { 'content-type': 'text/html' } })
  },
})
afterAll(() => serverNetworkSite.stop(true))

const readAs = async (url: string, token?: string) => {
  const response = await app.request(`/api/web-page?${new URLSearchParams({ url })}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('only a signed-in member reads a web page through the server', async () => {
  expect((await readAs('https://example.com')).status).toBe(401)
})

test('a page on the server’s own machine or network is refused without being reached, in any spelling', async () => {
  const token = await sessionTokenOf(database, acme, alice)
  for (const url of [
    `http://127.0.0.1:${serverNetworkSite.port}/admin`,
    `http://localhost:${serverNetworkSite.port}/admin`,
    `http://[::ffff:127.0.0.1]:${serverNetworkSite.port}/admin`,
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/',
    'http://0x7f.1/',
  ])
    expect(await readAs(url, token)).toEqual({
      status: 403,
      body: { error: 'web_page_not_public', message: 'This page is not on the public web, so Spyria does not open it' },
    })
  expect(reachedRequests).toBe(0)
  expect(await readAs('file:///etc/passwd', token)).toEqual({
    status: 502,
    body: { error: 'web_page_unreachable', message: 'This page could not be reached' },
  })
})
