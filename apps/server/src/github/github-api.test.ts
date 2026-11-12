import { afterAll, expect, test } from 'bun:test'
import { createGitHubApi } from './github-api.ts'

const titleSeenBy = (authorization: string | null) => `Fix the total for ${authorization}`
const titleOf = (token: string, number: number) =>
  github.pullRequest(token, 'acme/app', number).then(({ title }) => title)
const requests: { path: string; ifNoneMatch: string | null; authorization: string | null }[] = []
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    const ifNoneMatch = request.headers.get('if-none-match')
    const authorization = request.headers.get('authorization')
    requests.push({ path: pathname, ifNoneMatch, authorization })
    await Bun.sleep(5)
    if (pathname === '/repos/acme/app/pulls/404') return Response.json({ message: 'Not Found' }, { status: 404 })
    const etag = `"${authorization}"`
    if (ifNoneMatch === etag) return new Response(null, { status: 304 })
    return Response.json({ number: 7, title: titleSeenBy(authorization) }, { headers: { etag } })
  },
})
afterAll(() => server.stop(true))
const github = createGitHubApi({ apiUrl: server.url.href.replace(/\/$/, ''), webUrl: 'https://github.example' })

test('concurrent identical reads share one request, and a repeated read revalidates with its ETag', async () => {
  requests.length = 0
  expect(await Promise.all([titleOf('token-a', 7), titleOf('token-a', 7)])).toEqual([
    titleSeenBy('Bearer token-a'),
    titleSeenBy('Bearer token-a'),
  ])
  expect(requests).toEqual([{ path: '/repos/acme/app/pulls/7', ifNoneMatch: null, authorization: 'Bearer token-a' }])
  expect(await titleOf('token-a', 7)).toEqual(titleSeenBy('Bearer token-a'))
  expect(requests[1]).toEqual({
    path: '/repos/acme/app/pulls/7',
    ifNoneMatch: '"Bearer token-a"',
    authorization: 'Bearer token-a',
  })
})

test('another token never shares a read in flight and gets its own answer when GitHub does not confirm the ETag', async () => {
  requests.length = 0
  expect(await Promise.all([titleOf('token-b', 7), titleOf('token-c', 7)])).toEqual([
    titleSeenBy('Bearer token-b'),
    titleSeenBy('Bearer token-c'),
  ])
  expect(requests.map(({ authorization }) => authorization).toSorted()).toEqual(['Bearer token-b', 'Bearer token-c'])
})

test('a failed read is shared by the callers in flight but not kept', async () => {
  requests.length = 0
  const failures = await Promise.allSettled([
    github.pullRequest('token-a', 'acme/app', 404),
    github.pullRequest('token-a', 'acme/app', 404),
  ])
  expect(failures.map((failure) => failure.status === 'rejected' && String(failure.reason))).toEqual([
    'Error: Not Found (404)',
    'Error: Not Found (404)',
  ])
  await github.pullRequest('token-a', 'acme/app', 404).catch(() => undefined)
  expect(requests).toHaveLength(2)
})
