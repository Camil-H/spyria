import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { defaultBrowserSettings, chatId as toChatId } from '@spyria/kernel'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  failedWith,
  fakeBrowserFrame,
  fakeBrowserSnapshot,
  lee,
  mcpCall,
  rpcOf,
  runtimeTurn,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  textOf,
  waitFor,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const approvalWindowMilliseconds = 2_000
const stack = await startAgentStack({ routing: true, approvalWindowMilliseconds })
const { database, fakeHost, openStream, app } = stack

const browserCall = (name: string, args: object = {}) => rpcOf('tools/call', { name, arguments: args })
const callTool = async (host: Awaited<ReturnType<typeof fakeHost>>, token: string, name: string, args?: object) => {
  const answer = await mcpCall(host, token, browserCall(name, args), {}, undefined, '/mcp/spyria')
  return { text: textOf(answer.result), isError: answer.result?.isError === true, content: answer.result?.content }
}
const browserKeyOf = async (chatId: string, memberId: string) => {
  const [runtime] = await database.$client`select id from runtimes where chat_id = ${chatId}`
  return createHash('sha256')
    .update(JSON.stringify(['browser', acme, runtime?.id, memberId]))
    .digest('hex')
    .slice(0, 32)
}
const setBrowserSettings = async (settings: object) => {
  const browser = JSON.stringify({ ...defaultBrowserSettings, ...settings })
  await database.$client`update workspaces set browser = ${browser}::jsonb where workspace_id = ${acme}`
}
const toolCallRows = async (chatId: string) => [
  ...(await database.$client`
    select prompter_id, tool, read_only, decision, decided_by, status from tool_calls
    where chat_id = ${chatId} order by called_at`),
]

test("the agent drives the browser of the member who prompted, through the host, and never another member's", async () => {
  await setBrowserSettings({})
  const host = await fakeHost('Browser routing host')
  const { chatId, token } = await runtimeTurn(host, bob)
  expect(await callTool(host, token, 'browser_snapshot')).toMatchObject({ text: fakeBrowserSnapshot, isError: false })
  const bobsKey = await browserKeyOf(chatId, bob)
  expect(host.commands.filter(({ op }) => op.startsWith('browser_'))).toEqual([
    { op: 'browser_start', runtimeId: expect.any(String), browserKey: bobsKey },
  ])
  expect(host.browsers.received(bobsKey).map(({ type, command }) => type ?? command)).toEqual(['settings', 'snapshot'])
  expect(host.browsers.received(bobsKey)[0]).toEqual({
    type: 'settings',
    settings: {
      blockInternalNetworks: true,
      allowedInternalAddresses: [],
      allowedSites: [],
      blockedSites: [],
      downloads: true,
      uploads: true,
    },
  })

  await database.$client`update chats set agent_turn_prompter_id = ${alice} where id = ${chatId}`
  expect(await callTool(host, token, 'browser_screenshot')).toMatchObject({
    text: 'Screenshot of Example',
    content: [
      { type: 'text', text: 'Screenshot of Example' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' },
    ],
  })
  const alicesKey = await browserKeyOf(chatId, alice)
  expect(alicesKey).not.toBe(bobsKey)
  expect(host.browsers.received(alicesKey).map(({ type, command }) => type ?? command)).toEqual([
    'settings',
    'screenshot',
  ])
  expect(host.browsers.received(bobsKey)).toHaveLength(2)
  expect(await toolCallRows(chatId)).toEqual([
    {
      prompter_id: bob,
      tool: 'browser_snapshot',
      read_only: true,
      decision: 'not_needed',
      decided_by: null,
      status: 'succeeded',
    },
    {
      prompter_id: alice,
      tool: 'browser_screenshot',
      read_only: true,
      decision: 'not_needed',
      decided_by: null,
      status: 'succeeded',
    },
  ])
})

test('open_page opens a web address, localhost included, in the prompter’s browser, and records the visit in the audit log without its query', async () => {
  await setBrowserSettings({})
  const host = await fakeHost('Browser open host')
  const { chatId, token } = await runtimeTurn(host, alice)
  expect(await callTool(host, token, 'open_page', { address: 'http://localhost:3000/cart?session=secret' })).toEqual({
    text: 'Opened Example (http://localhost:3000/cart?session=secret)',
    isError: false,
    content: [{ type: 'text', text: 'Opened Example (http://localhost:3000/cart?session=secret)' }],
  })
  const visits = async () => [
    ...(await database.$client`
      select actor_id, payload from workspace_events
      where workspace_id = ${acme} and type = 'browser.visited' and payload->>'chatId' = ${chatId}`),
  ]
  await waitFor(async () => (await visits()).length === 1)
  expect(await visits()).toEqual([
    { actor_id: alice, payload: { chatId, memberId: alice, url: 'http://localhost:3000/cart' } },
  ])
  expect([...(await database.$client`select url from browser_pages where chat_id = ${chatId}`)]).toEqual([])
})

test('a visit is not recorded when the admin turned visit records off, and the agent is refused when the browser is off for agents', async () => {
  await setBrowserSettings({ recordVisits: false })
  const host = await fakeHost('Browser off host')
  const { chatId, token } = await runtimeTurn(host, alice)
  expect(await callTool(host, token, 'open_page', { address: 'https://example.com/' })).toMatchObject({
    isError: false,
  })
  await Bun.sleep(200)
  expect(
    await database.$client`select 1 from workspace_events where type = 'browser.visited' and payload->>'chatId' = ${chatId}`,
  ).toHaveLength(0)

  await setBrowserSettings({ forAgents: false })
  const before = host.commands.length
  expect(await callTool(host, token, 'browser_click', { ref: 'e2' })).toMatchObject({
    text: 'The browser is turned off for agents in this workspace',
    isError: true,
  })
  expect(host.commands.slice(before)).toEqual([])
  await setBrowserSettings({})
})

const approvalOf = async (frames: string[], count: number) => {
  const shown = () =>
    frames.map((frame) => JSON.parse(frame).question).filter((question) => question?.kind === 'approval')
  await waitFor(() => shown().length >= count)
  return shown()[count - 1]
}
const answerAs = async (userId: string, chatId: string, questionId: string, approve: boolean) =>
  (
    await app.request(`/api/chats/${chatId}/questions/${questionId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ approve }),
    })
  ).status

test('a click that submits, or a script, waits for the prompting member’s approval; a click that only reads does not', async () => {
  await setBrowserSettings({})
  const host = await fakeHost('Browser approvals host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const { frames } = await openStream(toChatId(chatId))
  expect(await callTool(host, token, 'browser_click', { ref: 'e2' })).toMatchObject({ text: 'click done' })

  const submitting = callTool(host, token, 'browser_click', { ref: 'e1' })
  const asked = await approvalOf(frames, 1)
  expect(asked.approval).toMatchObject({
    server: 'Spyria',
    tool: 'browser_click',
    answererId: bob,
    answererName: 'Bob',
  })
  expect(await answerAs(alice, chatId, asked.questionId, true)).toBe(403)
  expect(await answerAs(bob, chatId, asked.questionId, true)).toBe(200)
  expect(await submitting).toMatchObject({ text: 'click done', isError: false })

  const script = callTool(host, token, 'browser_run_javascript', { expression: 'document.cookie' })
  expect(await answerAs(bob, chatId, (await approvalOf(frames, 2)).questionId, false)).toBe(200)
  expect(await script).toEqual({
    text: 'Bob did not approve this step in their browser',
    isError: true,
    content: [{ type: 'text', text: 'Bob did not approve this step in their browser' }],
  })
  const bobsKey = await browserKeyOf(chatId, bob)
  expect(host.browsers.received(bobsKey).flatMap(({ command }) => (command ? [command] : []))).toEqual([
    'would_submit',
    'click',
    'would_submit',
    'click',
  ])
  expect(
    (await toolCallRows(chatId)).map(({ tool, decision, decided_by, status }) => ({
      tool,
      decision,
      decided_by,
      status,
    })),
  ).toEqual([
    { tool: 'browser_click', decision: 'not_needed', decided_by: null, status: 'succeeded' },
    { tool: 'browser_click', decision: 'approved', decided_by: bob, status: 'succeeded' },
    { tool: 'browser_run_javascript', decision: 'denied', decided_by: bob, status: 'refused' },
  ])

  const stopped = new AbortController()
  const stoppedCall = mcpCall(
    host,
    token,
    browserCall('browser_type', { ref: 'e3', text: 'hi', submit: true }),
    {},
    stopped.signal,
    '/mcp/spyria',
  )
  await approvalOf(frames, 3)
  stopped.abort()
  await stoppedCall
  const closedApprovals = async () => [
    ...(await database.$client`
      select step->>'closed' as closed from messages where chat_id = ${chatId} and step->>'kind' = 'approval'
      and step->>'closed' is not null`),
  ]
  await waitFor(async () => (await closedApprovals()).length === 1)
  expect(await closedApprovals()).toEqual([{ closed: 'stopped' }])
  expect(host.browsers.received(bobsKey).some(({ command }) => command === 'type')).toBe(false)

  await setBrowserSettings({ approveSubmits: false })
  expect(await callTool(host, token, 'browser_run_javascript', { expression: '1' })).toMatchObject({ isError: false })
  await setBrowserSettings({})
})

type BrowserFrame = { type: string; state?: string; data?: string; [field: string]: unknown }
const watchBrowser = async (chatId: string, memberId: string) => {
  const socket = new WebSocket(`ws://localhost:${stack.server.port}/api/browser`)
  const frames: BrowserFrame[] = []
  socket.onmessage = (message) => frames.push(JSON.parse(String(message.data)))
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  socket.send(JSON.stringify({ type: 'open', token: await sessionTokenOf(database, acme, memberId), chatId }))
  return {
    frames,
    send: (message: object) => socket.send(JSON.stringify(message)),
    stateOf: async () => {
      await waitFor(() => frames.some(({ type, state }) => type === 'state' && state !== 'starting'))
      return frames.findLast(({ type }) => type === 'state')
    },
    close: () => socket.close(),
  }
}

test('a member watches and drives only their own browser; the actions they send reach it only as known actions, and a member who cannot prompt gets none', async () => {
  await setBrowserSettings({})
  const host = await fakeHost('Browser watching host')
  const { chatId } = await runtimeTurn(host, bob)
  const bobs = await watchBrowser(chatId, bob)
  expect(await bobs.stateOf()).toEqual({ type: 'state', state: 'running', canBrowse: true })
  await waitFor(() => bobs.frames.some(({ type }) => type === 'frame'))
  expect(bobs.frames.filter(({ type }) => type !== 'state')).toEqual([
    { type: 'page', url: 'https://example.com/', title: 'Example' },
    { type: 'frame', data: fakeBrowserFrame, width: 800, height: 600 },
  ])
  const bobsKey = await browserKeyOf(chatId, bob)
  bobs.send({ type: 'input', event: { kind: 'key', action: 'down', key: 'a' } })
  bobs.send({ type: 'input', command: 'evaluate', expression: 'document.cookie' })
  bobs.send({ type: 'frame_ack' })
  await waitFor(() => host.browsers.received(bobsKey).some(({ type }) => type === 'frame_ack'))
  expect(host.browsers.received(bobsKey).slice(2)).toEqual([
    { type: 'input', event: { kind: 'key', action: 'down', key: 'a' } },
    { type: 'frame_ack' },
  ])

  const alices = await watchBrowser(chatId, alice)
  expect(await alices.stateOf()).toMatchObject({ state: 'running' })
  host.browsers.emit(bobsKey, { type: 'frame', data: 'Ym9i', width: 800, height: 600 })
  await waitFor(() => bobs.frames.filter(({ type }) => type === 'frame').length === 2)
  expect(alices.frames.filter(({ data }) => data === 'Ym9i')).toEqual([])
  expect(await browserKeyOf(chatId, alice)).not.toBe(bobsKey)

  const lees = await watchBrowser(chatId, lee)
  expect(await lees.stateOf()).toMatchObject({ state: 'unavailable' })
  for (const watcher of [bobs, alices, lees]) watcher.close()
})

test('with browsing off for members, a member watches the agent in their browser but cannot drive it', async () => {
  await setBrowserSettings({ forMembers: false })
  const host = await fakeHost('Browser watch-only host')
  const { chatId } = await runtimeTurn(host, alice)
  const watcher = await watchBrowser(chatId, alice)
  expect(await watcher.stateOf()).toEqual({ type: 'state', state: 'running', canBrowse: false })
  const key = await browserKeyOf(chatId, alice)
  watcher.send({ type: 'go_to', url: 'https://example.com/other' })
  watcher.send({ type: 'frame_ack' })
  await waitFor(() => host.browsers.received(key).some(({ type }) => type === 'frame_ack'))
  expect(host.browsers.received(key).some(({ type }) => type === 'go_to')).toBe(false)
  watcher.close()
  await setBrowserSettings({ forAgents: false, forMembers: false })
  const refused = await watchBrowser(chatId, alice)
  expect(await refused.stateOf()).toEqual({
    type: 'state',
    state: 'unavailable',
    reason: 'The browser is turned off in this workspace',
  })
  refused.close()
  await setBrowserSettings({})
})

test('only a member with tools.manage changes the browser settings, and invalid ones are refused', async () => {
  const settings = { ...defaultBrowserSettings, blockedSites: ['example.com'], signInHours: 8 }
  const setAs = (member: typeof aliceInAcme, browser: object) =>
    stack.mutate(member, 'workspace.setBrowserSettings', { workspaceId: acme, settings: browser })
  expect(await setAs(bobInAcme, settings)).toEqual(
    failedWith('Your workspace role does not allow this: Manage the tools catalogue'),
  )
  expect(await setAs(aliceInAcme, { ...settings, signInHours: 0 })).toEqual(
    failedWith(
      'Addresses are host names or IP addresses, at most 200 in each list and each once; sign-ins last from 1 hour to 30 days',
    ),
  )
  expect(await setAs(aliceInAcme, settings)).toEqual(succeeded)
  const [stored] = await database.$client`select browser from workspaces where workspace_id = ${acme}`
  expect(stored?.browser).toEqual(settings)
  expect([
    ...(await database.$client`
      select payload from workspace_events where workspace_id = ${acme} and type = 'browser.changed'`),
  ]).toContainEqual({ payload: { settings } })
  await setBrowserSettings({})
})
