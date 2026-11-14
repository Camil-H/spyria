import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { testCrmConnection } from '@spyria/db/testing'
import { chatId as toChatId } from '@spyria/kernel'
import { sharedToolServer } from './testing/fake-mcp.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  asMember,
  bob,
  bobInAcme,
  connectAlice,
  connectionPath,
  connectionRows,
  connectMember,
  createFakeHosts,
  lookup,
  mcpCall,
  openSharedTestApp,
  promptedBy,
  rpcOf,
  runtimeTurn,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  textOf,
  waitFor,
  whoami,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const approvalWindowMilliseconds = 2_000
let clockOffsetMilliseconds = 0
const approvals = await startAgentStack({
  routing: true,
  approvalWindowMilliseconds,
  now: () => Date.now() + clockOffsetMilliseconds,
})
const { database, port, fakeMcp } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())
afterAll(() => disconnectFakeHosts())

const aliceAccount = `alice-${crypto.randomUUID().slice(0, 8)}`
const aliceCookie = `fake_mcp_user=${aliceAccount}`
const bobAccount = `bob-${crypto.randomUUID().slice(0, 8)}`
const bobCookie = `fake_mcp_user=${bobAccount}`
beforeEach(() => asMember(alice, 'POST', connectionPath('disconnect')))

const update = rpcOf('tools/call', { name: `${sharedToolServer}-update`, arguments: { text: 'new' } })
const toolCallRows = async (chatId: string, count: number) => {
  const rows = async () => [
    ...(await database.$client`
      select prompter_id, owner_id, server, tool, read_only, decision, decided_by, status
      from tool_calls where chat_id = ${chatId} order by called_at`),
  ]
  await waitFor(async () => (await rows()).length >= count)
  return rows()
}
const allowOnlySharedTools = async (roleId: string, allowedTools: string[] | null) => {
  const answer = await asMember(alice, 'POST', '/api/workspace-connections/connection-crm/access', {
    roleId,
    level: allowedTools === null ? 'write' : 'none',
    toolChanges: Object.fromEntries((allowedTools ?? []).map((tool) => [tool, true])),
  })
  if (answer.status !== 200) throw new Error(`Setting the access of ${roleId} answered ${answer.status}`)
}
const refused = (answer: { status: number | undefined; result: { content?: { text: string }[] } }) => ({
  status: answer.status,
  text: textOf(answer.result),
})

test('on a guest’s prompt a server each member signs in to runs on the guest’s own account, never the owner’s: unconnected, the call names the guest to connect; every call is audited', async () => {
  await connectAlice(aliceCookie)
  const host = await fakeHost('Guest own-account host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const callsBefore = fakeMcp.records.length
  try {
    await mcpCall(host, token, rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    const unconnected = await mcpCall(host, token, whoami)
    expect(unconnected).toMatchObject({ status: 200, result: { isError: true } })
    expect(textOf(unconnected.result)).toBe('Bob needs to connect fake')
    expect(fakeMcp.records.slice(callsBefore).filter((record) => record.user === aliceAccount)).toEqual([])

    await connectMember(bob, bobCookie)
    expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${bobAccount}`)
    await promptedBy(chatId, alice)
    expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${aliceAccount}`)
    expect(await connectionRows()).toEqual(
      expect.arrayContaining([
        { user_id: alice, tool: 'fake', status: 'Connected' },
        { user_id: bob, tool: 'fake', status: 'Connected' },
      ]),
    )
  } finally {
    await asMember(bob, 'POST', connectionPath('disconnect'))
  }
  const audited = { owner_id: alice, server: 'fake', tool: 'whoami', read_only: true, decided_by: null }
  expect(await toolCallRows(chatId, 3)).toEqual([
    { ...audited, prompter_id: bob, decision: 'not_needed', status: 'failed' },
    { ...audited, prompter_id: bob, decision: 'not_needed', status: 'succeeded' },
    { ...audited, prompter_id: alice, decision: 'not_needed', status: 'succeeded' },
  ])
})

test('on a guest’s prompt a shared-login tool needs both the owner’s and the guest’s access, each refusal says whose access lacks it, and the gateway only sees that server', async () => {
  await addLlmKey(bob, 'Mistral')
  const host = await fakeHost('Guest workspace host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const callsBefore = fakeMcp.records.length
  try {
    expect(textOf((await mcpCall(host, token, lookup)).result)).toBe('ran lookup')

    await allowOnlySharedTools('member', ['update'])
    expect(refused(await mcpCall(host, token, lookup))).toEqual({
      status: 200,
      text: `Bob's access to ${testCrmConnection.name} does not include lookup in this chat`,
    })
    await allowOnlySharedTools('member', null)
    await allowOnlySharedTools('admin', ['update'])
    expect(refused(await mcpCall(host, token, lookup))).toEqual({
      status: 200,
      text: `${testCrmConnection.name} isn't available on Bob's prompts in this chat`,
    })
  } finally {
    await allowOnlySharedTools('admin', null)
    await allowOnlySharedTools('member', null)
  }
  expect(fakeMcp.records.slice(callsBefore)).toEqual([{ tool: 'lookup', user: 'shared' }])
  const audited = {
    prompter_id: bob,
    owner_id: alice,
    server: sharedToolServer,
    decision: 'not_needed',
    decided_by: null,
  }
  expect(await toolCallRows(chatId, 3)).toEqual([
    { ...audited, tool: 'lookup', read_only: true, status: 'succeeded' },
    { ...audited, tool: 'lookup', read_only: null, status: 'refused' },
    { ...audited, tool: 'lookup', read_only: null, status: 'refused' },
  ])
})

test('a guest’s turn answers only tool and session methods, so resources, prompts and batches never reach the gateway, and a batch is refused on the owner’s turn too', async () => {
  const host = await fakeHost('Guest methods host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const notFound = { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }
  for (const method of ['resources/list', 'prompts/list', 'completion/complete'])
    expect(JSON.parse((await mcpCall(host, token, rpcOf(method))).body)).toEqual(notFound)
  expect(JSON.parse((await mcpCall(host, token, `[${whoami}]`)).body)).toEqual({ ...notFound, id: null })
  expect(
    (await mcpCall(host, token, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status,
  ).toBe(202)
  expect((await mcpCall(host, token, rpcOf('ping'))).result).toEqual({})

  await promptedBy(chatId, alice)
  expect(JSON.parse((await mcpCall(host, token, rpcOf('resources/list'))).body).error.message).toBe(
    'resources not supported',
  )
  const callsBefore = fakeMcp.records.length
  expect(JSON.parse((await mcpCall(host, token, `[${lookup}]`)).body)).toEqual({ ...notFound, id: null })
  expect(fakeMcp.records.slice(callsBefore)).toEqual([])
})

const delegationTokenOn = async (chatId: string) => {
  const subToken = `dl_${crypto.randomUUID().replaceAll('-', '')}`
  const tokenHash = createHash('sha256').update(JSON.stringify(subToken)).digest('hex')
  await database.$client`
    insert into delegations (workspace_id, chat_id, id, prompt_id, task, effort_hint, policy, model, reason, status, token_hash, created_at)
    select workspace_id, id, ${crypto.randomUUID()}, agent_turn_message_id, 'Look up', 'small', 'auto', 'mistral/mistral-small-latest', 'asked', 'running', ${tokenHash}, now()
    from chats where id = ${chatId}`
  return subToken
}
const nextPromptBy = async (chatId: string, prompterId: string) => {
  const promptId = `message-${crypto.randomUUID()}`
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${chatId}, ${promptId}, 2, 'member', ${prompterId}, 'Next', now())`
  await database.$client`
    insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
    values (${acme}, ${chatId}, ${promptId}, 2, 'message.posted', ${prompterId}, '{}', now())`
  await database.$client`
    update chats set agent_turn_message_id = ${promptId}, agent_turn_prompter_id = ${prompterId} where id = ${chatId}`
}

test('a sub-agent token acts only during the turn that started its delegation, never on the owner’s next turn', async () => {
  const host = await fakeHost('Delegation turn host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const subToken = await delegationTokenOn(chatId)
  const completionWith = (callToken: string) =>
    host.modelCall({
      headers: { authorization: `Bearer ${callToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral/mistral-small-latest', messages: [{ role: 'user', content: 'hi' }] }),
    })
  expect((await mcpCall(host, subToken, rpcOf('tools/list'))).status).toBe(200)

  await nextPromptBy(chatId, alice)
  expect((await mcpCall(host, subToken, rpcOf('tools/list'))).status).toBe(401)
  expect((await mcpCall(host, subToken, lookup)).status).toBe(401)
  expect(await completionWith(subToken)).toMatchObject({ status: 401 })
  expect((await mcpCall(host, token, rpcOf('tools/list'))).status).toBe(200)
})

const approvalOf = async (frames: string[], count: number) => {
  const shown = () =>
    frames.map((frame) => JSON.parse(frame).question).filter((question) => question?.kind === 'approval')
  await waitFor(() => shown().length >= count)
  return shown()[count - 1]
}
const answerAs = async (userId: string, chatId: string, questionId: string, approve: boolean) =>
  (
    await approvals.app.request(`/api/chats/${chatId}/questions/${questionId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ approve }),
    })
  ).status
const guestTurnWithApprovals = async (name: string) => {
  const host = await approvals.fakeHost(name)
  const { chatId, token } = await runtimeTurn(host, bob)
  return { host, chatId, token, frames: (await approvals.openStream(toChatId(chatId))).frames }
}
const approvalStepsOf = async (chatId: string, count: number) => {
  const steps = async () =>
    (
      await database.$client`
        select step from messages where chat_id = ${chatId} and step->>'kind' = 'approval' order by seq`
    ).map(({ step }) => ({ approved: step.approved, answeredBy: step.answeredBy, closed: step.closed }))
  await waitFor(async () => (await steps()).length >= count)
  return steps()
}
const notApproved = { status: 200, text: 'Alice did not approve this call' }

test('a guest’s write call on a shared login waits for the owner: approved it runs, denied it gets the refusal; only the owner answers and read-only calls never wait', async () => {
  const { host, chatId, token, frames } = await guestTurnWithApprovals('Approvals host')
  const callsBefore = fakeMcp.records.length
  expect(textOf((await mcpCall(host, token, lookup)).result)).toBe('ran lookup')

  const approvedCall = mcpCall(host, token, update)
  const first = await approvalOf(frames, 1)
  expect(first).toMatchObject({
    sessionUpdate: 'question',
    approval: {
      server: testCrmConnection.name,
      tool: 'update',
      arguments: '{"text":"new"}',
      prompterName: 'Bob',
      answererId: alice,
      answererName: 'Alice',
    },
  })
  expect(await answerAs(bob, chatId, first.questionId, true)).toBe(403)
  expect(await answerAs(alice, chatId, first.questionId, true)).toBe(200)
  expect(textOf((await approvedCall).result)).toBe('ran update')
  expect(await answerAs(alice, chatId, first.questionId, true)).toBe(409)

  const deniedCall = mcpCall(host, token, update)
  expect(await answerAs(alice, chatId, (await approvalOf(frames, 2)).questionId, false)).toBe(200)
  expect(refused(await deniedCall)).toEqual(notApproved)

  expect(fakeMcp.records.slice(callsBefore)).toEqual([
    { tool: 'lookup', user: 'shared' },
    { tool: 'update', user: 'shared' },
  ])
  expect(await approvalStepsOf(chatId, 2)).toEqual([
    { approved: true, answeredBy: alice, closed: undefined },
    { approved: false, answeredBy: alice, closed: undefined },
  ])
  const audited = { prompter_id: bob, owner_id: alice, server: sharedToolServer }
  expect(await toolCallRows(chatId, 3)).toEqual([
    { ...audited, tool: 'lookup', read_only: true, decision: 'not_needed', decided_by: null, status: 'succeeded' },
    { ...audited, tool: 'update', read_only: false, decision: 'approved', decided_by: alice, status: 'succeeded' },
    { ...audited, tool: 'update', read_only: false, decision: 'denied', decided_by: alice, status: 'refused' },
  ])
})

test('an approval nobody answers expires, Stop cancels a pending one, and the owner’s own write call never asks', async () => {
  const { host, chatId, token, frames } = await guestTurnWithApprovals('Expiring approvals host')
  const startedAt = Date.now()
  const expiringCall = mcpCall(host, token, update)
  await approvalOf(frames, 1)
  expect(refused(await expiringCall)).toEqual(notApproved)
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(approvalWindowMilliseconds)

  const stoppedCall = mcpCall(host, token, update)
  await approvalOf(frames, 2)
  await approvals.mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId })
  expect(refused(await stoppedCall)).toEqual(notApproved)

  const ownerTurn = await runtimeTurn(host, alice)
  expect(textOf((await mcpCall(host, ownerTurn.token, update)).result)).toBe('ran update')
  expect(await approvalStepsOf(chatId, 2)).toEqual([
    { approved: undefined, answeredBy: undefined, closed: 'expired' },
    { approved: undefined, answeredBy: undefined, closed: 'stopped' },
  ])
  const audited = { owner_id: alice, server: sharedToolServer, tool: 'update', read_only: false, decided_by: null }
  expect(await toolCallRows(chatId, 2)).toEqual([
    { ...audited, prompter_id: bob, decision: 'expired', status: 'refused' },
    { ...audited, prompter_id: bob, decision: 'cancelled', status: 'refused' },
  ])
  expect(await toolCallRows(ownerTurn.chatId, 1)).toEqual([
    { ...audited, prompter_id: alice, decision: 'not_needed', status: 'succeeded' },
  ])
  expect(frames.filter((frame) => JSON.parse(frame).question).length).toBe(2)
})

test('a call approved after Stop was asked for, before its turn has stopped, is refused and never runs', async () => {
  const host = await approvals.fakeHost('Stopping approvals host')
  const { chatId, token, promptId } = await runtimeTurn(host, bob)
  const { frames } = await approvals.openStream(toChatId(chatId))
  const callsBefore = fakeMcp.records.length
  const approvedCall = mcpCall(host, token, update)
  const asked = await approvalOf(frames, 1)
  await database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
    values (${acme}, ${`job-stop-${promptId}`}, 'agent.interrupt',
      ${JSON.stringify({ chatId, promptId, memberId: alice })}::jsonb, now() + interval '1 hour', 0, 'queued')`

  expect(await answerAs(alice, chatId, asked.questionId, true)).toBe(200)
  expect(refused(await approvedCall)).toEqual({ status: 200, text: 'The turn was stopped before this call ran' })
  expect(fakeMcp.records.slice(callsBefore)).toEqual([])
  expect(await toolCallRows(chatId, 1)).toEqual([
    {
      prompter_id: bob,
      owner_id: alice,
      server: sharedToolServer,
      tool: 'update',
      read_only: false,
      decision: 'cancelled',
      decided_by: null,
      status: 'refused',
    },
  ])
  await database.$client`delete from jobs where id = ${`job-stop-${promptId}`}`
})

test('a pending approval is cancelled when its request aborts or its turn ends, and its card shows Stopped', async () => {
  const { host, chatId, token, frames } = await guestTurnWithApprovals('Cancelled approvals host')
  const aborted = new AbortController()
  const abortedCall = mcpCall(host, token, update, {}, aborted.signal)
  await approvalOf(frames, 1)
  aborted.abort()
  await abortedCall

  const endedCall = mcpCall(host, token, update)
  await approvalOf(frames, 2)
  clockOffsetMilliseconds = 3_600_000
  try {
    await approvals.agentBridge
      .forDatabase(database)
      .jobs['agent.sweep']({ workspaceId: acme, payload: {}, isLastAttempt: false })
  } finally {
    clockOffsetMilliseconds = 0
  }
  expect(refused(await endedCall)).toEqual(notApproved)
  expect(await approvalStepsOf(chatId, 2)).toEqual([
    { approved: undefined, answeredBy: undefined, closed: 'stopped' },
    { approved: undefined, answeredBy: undefined, closed: 'stopped' },
  ])
  const cancelled = { prompter_id: bob, owner_id: alice, server: sharedToolServer, tool: 'update', read_only: false }
  expect(await toolCallRows(chatId, 2)).toEqual([
    { ...cancelled, decision: 'cancelled', decided_by: null, status: 'refused' },
    { ...cancelled, decision: 'cancelled', decided_by: null, status: 'refused' },
  ])
})

test('on a shared login the owner’s approval choices decide which calls wait: Always asks on their own prompt, and Never lets a guest’s write run', async () => {
  const chooseApproval = async (tool: string | null, approval: string | null) =>
    expect(
      await approvals.mutate(aliceInAcme, 'profile.setToolApproval', {
        workspaceId: acme,
        connectionId: testCrmConnection.id,
        tool,
        approval,
      }),
    ).toEqual(succeeded)
  try {
    await chooseApproval('update', 'always')
    const host = await approvals.fakeHost('Approval choices host')
    const ownerTurn = await runtimeTurn(host, alice)
    const { frames } = await approvals.openStream(toChatId(ownerTurn.chatId))
    const ownerCall = mcpCall(host, ownerTurn.token, update)
    const asked = await approvalOf(frames, 1)
    expect(asked).toMatchObject({
      approval: { tool: 'update', prompterName: 'Alice', answererId: alice, answererName: 'Alice' },
    })
    expect(await answerAs(alice, ownerTurn.chatId, asked.questionId, true)).toBe(200)
    expect(textOf((await ownerCall).result)).toBe('ran update')

    await chooseApproval('update', null)
    await chooseApproval(null, 'never')
    const guestTurn = await runtimeTurn(host, bob)
    expect(textOf((await mcpCall(host, guestTurn.token, update)).result)).toBe('ran update')
    const audited = { owner_id: alice, server: sharedToolServer, tool: 'update', read_only: false, status: 'succeeded' }
    expect(await toolCallRows(ownerTurn.chatId, 1)).toEqual([
      { ...audited, prompter_id: alice, decision: 'approved', decided_by: alice },
    ])
    expect(await toolCallRows(guestTurn.chatId, 1)).toEqual([
      { ...audited, prompter_id: bob, decision: 'not_needed', decided_by: null },
    ])
  } finally {
    await chooseApproval('update', null)
    await chooseApproval(null, null)
  }
})

test('on a server each member signs in to, the prompter’s approval choices apply and the prompter answers, not the owner', async () => {
  const chooseApproval = async (context: typeof aliceInAcme, approval: string | null) =>
    expect(
      await approvals.mutate(context, 'profile.setToolApproval', {
        workspaceId: acme,
        connectionId: 'connection-fake',
        tool: 'whoami',
        approval,
      }),
    ).toEqual(succeeded)
  await connectMember(bob, bobCookie)
  try {
    await chooseApproval(bobInAcme, 'always')
    const { host, chatId, token, frames } = await guestTurnWithApprovals('Prompter approvals host')
    await mcpCall(host, token, rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    const bobCall = mcpCall(host, token, whoami)
    const asked = await approvalOf(frames, 1)
    expect(asked).toMatchObject({
      approval: { server: 'fake', tool: 'whoami', prompterName: 'Bob', answererId: bob, answererName: 'Bob' },
    })
    expect(await answerAs(alice, chatId, asked.questionId, true)).toBe(403)
    expect(await answerAs(bob, chatId, asked.questionId, true)).toBe(200)
    expect(textOf((await bobCall).result)).toBe(`you are ${bobAccount}`)

    await chooseApproval(bobInAcme, null)
    await chooseApproval(aliceInAcme, 'always')
    expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${bobAccount}`)
    const audited = { prompter_id: bob, owner_id: alice, server: 'fake', tool: 'whoami', read_only: true }
    expect(await toolCallRows(chatId, 2)).toEqual([
      { ...audited, decision: 'approved', decided_by: bob, status: 'succeeded' },
      { ...audited, decision: 'not_needed', decided_by: null, status: 'succeeded' },
    ])
  } finally {
    await chooseApproval(bobInAcme, null)
    await chooseApproval(aliceInAcme, null)
    await asMember(bob, 'POST', connectionPath('disconnect'))
  }
})
