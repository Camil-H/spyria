import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { openSessions } from './auth/sessions.ts'
import { startJobWorker } from './job-worker.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  failedWith,
  globex,
  inviteToAcme,
  issueTestSession,
  jobDone,
  lee,
  newChat,
  openSharedTestApp,
  removeFromAcme,
  sendTo,
  succeeded,
  testAuthSettings,
  waitFor,
  waitingOnLock,
  workspaceEventsOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)

const { database, app, gateway, llmGateway, resultOf, changesOf } = await openSharedTestApp()
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  cleanupRetryDelayMilliseconds: 100,
  maximumCleanupRetryDelayMilliseconds: 400,
  llmGateway,
})
afterAll(() => worker.stop())

const cannotInvite = failedWith('Your workspace role does not allow this: Invite members')
const cannotManageMembers = failedWith('Your workspace role does not allow this: Change roles and remove members')
const lastAdmin = failedWith('The last admin of a workspace can be neither demoted nor removed')
const ownMembership = failedWith('You can neither change your own role nor remove yourself')
const frozen = failedWith('This chat is frozen: its owner left the workspace')
const invitationsOf = async (email: string) => [
  ...(await database.$client`
    select id, email, role, invited_by, expires_at - created_at as lifetime, revoked_at, accepted_at
    from invitations where email = ${email} order by created_at`),
]
const membershipOf = async (userId: string) =>
  (
    await database.$client`select role, removed_at from memberships where workspace_id = ${acme} and user_id = ${userId}`
  )[0]
const queryAs = (token: string) =>
  app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', [{ id: 'chats', name: 'chats', args: [] }]]),
  })
const renewWith = (sessionId: string) =>
  app.request('/auth/renew', {
    method: 'POST',
    headers: {
      origin: testAuthSettings.appOrigin,
      'x-spyria-csrf': '1',
      'content-type': 'application/json',
      cookie: `spyria_s_${acme}=${sessionId}`,
    },
    body: JSON.stringify({ workspaceId: acme }),
  })
const changeRole = (member: typeof aliceInAcme, memberId: string, role: string) =>
  resultOf(member, 'workspace.changeMemberRole', { workspaceId: acme, memberId, role })
const transfer = (member: typeof aliceInAcme, chatId: string, ownerId: string) =>
  resultOf(member, 'workspace.transferChat', { workspaceId: acme, chatId, ownerId })

test('an admin invites a normalized email once for 7 days and revokes it, at once even when the workspace has its own SSO; a member does neither', async () => {
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${acme}, 'oidc', 'https://idp.example.com', 'spyria-acme', 'sealed-secret', now())`
  try {
    expect(await inviteToAcme(app, database, ' Nina@Example.COM ')).toEqual(succeeded)
    const [invitation] = await invitationsOf('nina@example.com')
    expect(invitation).toMatchObject({ role: 'member', invited_by: alice, lifetime: '7 days', revoked_at: null })
    expect(await inviteToAcme(app, database, 'nina@example.com', 'admin')).toEqual(
      failedWith('nina@example.com already has a pending invite'),
    )
    expect(await inviteToAcme(app, database, 'BOB@example.com')).toEqual(
      failedWith('bob@example.com is already a member of this workspace'),
    )
    expect(await inviteToAcme(app, database, 'not an email')).toEqual(failedWith('not an email is not an email'))
    const invitationId = String(invitation?.id)
    expect(
      await resultOf(bobInAcme, 'workspace.inviteMember', {
        workspaceId: acme,
        id: 'by-bob',
        email: 'x@example.com',
        role: 'member',
      }),
    ).toEqual(cannotInvite)
    expect(await resultOf(bobInAcme, 'workspace.revokeInvite', { workspaceId: acme, invitationId })).toEqual(
      cannotInvite,
    )
    expect(await resultOf(aliceInAcme, 'workspace.revokeInvite', { workspaceId: acme, invitationId })).toEqual(
      succeeded,
    )
    expect(await resultOf(aliceInAcme, 'workspace.revokeInvite', { workspaceId: acme, invitationId })).toEqual(
      failedWith(`Invite ${invitationId} is not pending`),
    )
    expect((await invitationsOf('nina@example.com'))[0]?.revoked_at).not.toBeNull()
    expect(await workspaceEventsOf(database)).toEqual([
      {
        type: 'member.invited',
        actorId: alice,
        payload: { invitationId, email: 'nina@example.com', role: 'member' },
      },
      { type: 'invite.revoked', actorId: alice, payload: { invitationId, email: 'nina@example.com' } },
    ])
  } finally {
    await database.$client`delete from workspace_sso where workspace_id = ${acme}`
  }
})

test('an expired invite does not block a new one, which replaces it', async () => {
  expect(await inviteToAcme(app, database, 'olga@example.com')).toEqual(succeeded)
  await database.$client`update invitations set expires_at = now() - interval '1 second' where email = 'olga@example.com'`
  expect(await inviteToAcme(app, database, 'olga@example.com', 'admin')).toEqual(succeeded)
  const [expired, renewed] = await invitationsOf('olga@example.com')
  expect(expired?.revoked_at).not.toBeNull()
  expect(renewed).toMatchObject({ role: 'admin', revoked_at: null, accepted_at: null })
})

test('an admin changes the roles of others, never their own nor removes themselves, and a member changes nothing', async () => {
  expect(await changeRole(bobInAcme, lee, 'admin')).toEqual(cannotManageMembers)
  expect(await changeRole(aliceInAcme, alice, 'member')).toEqual(ownMembership)
  expect(await removeFromAcme(app, database, alice)).toEqual(ownMembership)
  expect(await changeRole(aliceInAcme, bob, 'admin')).toEqual(succeeded)
  expect(await membershipOf(bob)).toEqual({ role: 'admin', removed_at: null })
  expect(await changeRole(bobInAcme, alice, 'member')).toEqual(succeeded)
  expect(await changeRole(bobInAcme, bob, 'member')).toEqual(ownMembership)
  expect(await resultOf(bobInAcme, 'workspace.removeMember', { workspaceId: acme, memberId: bob })).toEqual(
    ownMembership,
  )
  expect(await changeRole(bobInAcme, alice, 'admin')).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, 'member')).toEqual(succeeded)
  expect(await changeRole(bobInAcme, alice, 'member')).toEqual(cannotManageMembers)
  expect((await workspaceEventsOf(database)).filter(({ type }) => type === 'member.role_changed')).toEqual([
    { type: 'member.role_changed', actorId: alice, payload: { memberId: bob, role: 'admin' } },
    { type: 'member.role_changed', actorId: bob, payload: { memberId: alice, role: 'member' } },
    { type: 'member.role_changed', actorId: bob, payload: { memberId: alice, role: 'admin' } },
    { type: 'member.role_changed', actorId: alice, payload: { memberId: bob, role: 'member' } },
  ])
})

test('two admins demoting each other at once leave one admin: the last-admin guard stays as the safety net', async () => {
  expect(await changeRole(aliceInAcme, bob, 'admin')).toEqual(succeeded)
  const results = await Promise.all([changeRole(aliceInAcme, bob, 'member'), changeRole(bobInAcme, alice, 'member')])
  const [refused, ...others] = results.filter((result) => !Bun.deepEquals(result, succeeded))
  expect(others).toEqual([])
  expect([lastAdmin, cannotManageMembers]).toContainEqual(refused)
  const admins = await database.$client`
    select user_id from memberships where workspace_id = ${acme} and role = 'admin' and removed_at is null`
  expect(admins).toHaveLength(1)
  if (admins[0]?.user_id === bob) expect(await changeRole(bobInAcme, alice, 'admin')).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, 'member')).toEqual(succeeded)
})

test('a role change waiting on a removal in progress is refused once it commits, so the removal is never undone', async () => {
  const dana = `member-${crypto.randomUUID()}`
  await database.$client`insert into users (id, email) values (${dana}, ${`${dana}@example.com`})`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${acme}, ${dana}, 'member', 'Dana')`
  let roleChange: ReturnType<typeof changeRole> | undefined
  await database.$client.begin(async (removal) => {
    await removal`update memberships set removed_at = now() where workspace_id = ${acme} and user_id = ${dana}`
    roleChange = changeRole(aliceInAcme, dana, 'admin')
    await waitFor(() => waitingOnLock(database))
  })

  expect(await roleChange).toEqual(failedWith(`${dana} is not a member of this workspace`))
  expect((await membershipOf(dana))?.removed_at).not.toBeNull()
})

test('a revoke waiting on an acceptance in progress is refused once it commits, so the invite stays accepted and no revoke is recorded', async () => {
  expect(await inviteToAcme(app, database, 'pia@example.com')).toEqual(succeeded)
  const invitationId = String((await invitationsOf('pia@example.com'))[0]?.id)
  let revoke: ReturnType<typeof resultOf> | undefined
  await database.$client.begin(async (acceptance) => {
    await acceptance`
      select 1 from invitations where workspace_id = ${acme} and id = ${invitationId} and revoked_at is null for update`
    await acceptance`update invitations set accepted_at = now() where workspace_id = ${acme} and id = ${invitationId}`
    revoke = resultOf(aliceInAcme, 'workspace.revokeInvite', { workspaceId: acme, invitationId })
    await waitFor(() => waitingOnLock(database))
  })

  expect(await revoke).toEqual(failedWith(`Invite ${invitationId} is not pending`))
  const [invitation] = await invitationsOf('pia@example.com')
  expect(invitation?.accepted_at).not.toBeNull()
  expect(invitation?.revoked_at).toBeNull()
  expect(
    (await workspaceEventsOf(database)).filter(
      ({ type, payload }) => type === 'invite.revoked' && payload.invitationId === invitationId,
    ),
  ).toEqual([])
})

test('an admin signs a member out everywhere in the workspace, which is recorded, keeps their membership and cannot be undone from their other workspaces; a member signs nobody out', async () => {
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${globex}, ${bob}, 'member', 'Bob')`
  const bobInGlobex = await issueTestSession(database, globex, bob)
  const bobSessions = [await issueTestSession(database, acme, bob), await issueTestSession(database, acme, bob)]
  const aliceToken = (await issueTestSession(database, acme, alice)).token
  const endSessionsOf = (member: typeof aliceInAcme, memberId: string) =>
    resultOf(member, 'workspace.endMemberSessions', { workspaceId: acme, memberId })

  expect(await endSessionsOf(bobInAcme, alice)).toEqual(cannotManageMembers)
  expect((await queryAs(aliceToken)).status).toBe(200)

  expect(await endSessionsOf(aliceInAcme, bob)).toEqual(succeeded)
  for (const { token, sessionId } of bobSessions) {
    expect((await queryAs(token)).status).toBe(401)
    expect((await renewWith(sessionId)).status).toBe(401)
  }
  expect(await membershipOf(bob)).toEqual({ role: 'member', removed_at: null })
  expect((await workspaceEventsOf(database)).at(-1)).toEqual({
    type: 'member.sessions_ended',
    actorId: alice,
    payload: { memberId: bob },
  })
  expect((await queryAs(aliceToken)).status).toBe(200)
  const openFrom = (token: string, workspaceId: string) =>
    app.request('/auth/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId }),
    })
  expect((await openFrom(bobInGlobex.token, acme)).status).toBe(403)
  const relayedThroughGlobex = await openFrom(bobInGlobex.token, globex)
  expect(relayedThroughGlobex.status).toBe(200)
  const { token: relayedToken } = (await relayedThroughGlobex.json()) as { token: string }
  expect((await openFrom(relayedToken, acme)).status).toBe(403)
  expect((await queryAs(bobInGlobex.token)).status).toBe(200)
  expect((await queryAs((await issueTestSession(database, acme, bob)).token)).status).toBe(200)
  await database.$client`delete from memberships where workspace_id = ${globex} and user_id = ${bob}`
})

test('removing a member ends their sessions, participations, keys and connections (their GitHub one too); their runtime chat freezes, their channel stays open', async () => {
  await addLlmKey(bob, 'openai')
  const [credential] = await database.$client`select secret_ref from llm_credentials where user_id = ${bob}`
  const providerKeyId = String(credential?.secret_ref).replace(/^gateway:openai\//, '')
  const [gatewayKey] = await database.$client`select virtual_key_id from member_gateway_keys where user_id = ${bob}`
  const virtualKeyId = String(gatewayKey?.virtual_key_id)
  await database.$client`
    insert into tool_connections (workspace_id, user_id, connection_id, status) values (${acme}, ${bob}, 'connection-fake', 'Connected')`
  await database.$client`
    insert into tool_approvals (workspace_id, user_id, connection_id, server_approval, tool_approvals)
    values (${acme}, ${bob}, 'connection-crm', 'always', '{}')`
  await database.$client`
    insert into github_connections (workspace_id, user_id, login, encrypted_access_token, updated_at)
    values (${acme}, ${bob}, 'bob-gh', 'sealed', now())`
  const alicesChat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: bob, roleId: 'prompter' }],
  })
  const bobsChannel = await newChat({
    ownerId: bob,
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: alice, roleId: 'prompter' }],
  })
  const bobsRuntimeChat = await newChat({ ownerId: bob, participants: [{ memberId: alice, roleId: 'prompter' }] })
  const bobSession = await issueTestSession(database, acme, bob)
  expect((await queryAs(bobSession.token)).status).toBe(200)
  expect(await removeFromAcme(app, database, bob)).toEqual(succeeded)

  expect((await queryAs(bobSession.token)).status).toBe(401)
  expect((await renewWith(bobSession.sessionId)).status).toBe(401)
  expect((await membershipOf(bob))?.removed_at).not.toBeNull()
  expect(await database.$client`select 1 from sessions where user_id = ${bob}`).toHaveLength(0)
  expect(await openSessions(database, bob, acme)).toHaveLength(0)
  const chatIdsOf = async (rows: PromiseLike<readonly { id: string }[]>) => (await rows).map(({ id }) => id).toSorted()
  const ownedChatIds = await chatIdsOf(
    database.$client<{ id: string }[]>`select id from chats where owner_user_id = ${bob}`,
  )
  expect(ownedChatIds).toEqual(expect.arrayContaining([bobsChannel, bobsRuntimeChat]))
  expect(
    await chatIdsOf(
      database.$client<{ id: string }[]>`select chat_id as id from chat_participants where user_id = ${bob}`,
    ),
  ).toEqual(ownedChatIds)
  expect((await changesOf(alicesChat)).at(-1)).toMatchObject({
    type: 'member.removed',
    actor: alice,
    payload: { memberId: bob },
  })
  for (const table of ['llm_credentials', 'tool_connections', 'tool_approvals', 'github_connections'])
    expect(await database.$client`select 1 from ${database.$client(table)} where user_id = ${bob}`).toHaveLength(0)
  await jobDone('profile.gateway-sync', { memberId: bob })
  expect(await database.$client`select 1 from member_gateway_keys where user_id = ${bob}`).toHaveLength(0)
  expect(
    ((await gateway.call<{ keys: { id: string }[] | null }>('/api/providers/openai/keys')).keys ?? []).map(
      ({ id }) => id,
    ),
  ).not.toContain(providerKeyId)
  expect((await gateway.request(`/api/governance/virtual-keys/${virtualKeyId}`)).status).toBe(404)
  expect(await workspaceEventsOf(database)).toContainEqual({
    type: 'member.removed',
    actorId: alice,
    payload: { memberId: bob },
  })

  expect(await sendTo(aliceInAcme, bobsRuntimeChat, `message-${crypto.randomUUID()}`, 'Still there?')).toEqual(frozen)
  expect(await sendTo(aliceInAcme, bobsChannel, `message-${crypto.randomUUID()}`, 'Channel still open')).toEqual(
    succeeded,
  )
  expect(await sendTo(aliceInAcme, alicesChat, `message-${crypto.randomUUID()}`, 'Not frozen')).toEqual(succeeded)
  expect(await removeFromAcme(app, database, bob)).toEqual(failedWith(`${bob} is not a member of this workspace`))
  expect(await resultOf(aliceInAcme, 'workspace.endMemberSessions', { workspaceId: acme, memberId: bob })).toEqual(
    failedWith(`${bob} is not a member of this workspace`),
  )
})

test("an admin transfers a removed member's chat to an active member, which unfreezes it; a chat of an active owner cannot be transferred", async () => {
  const leesChat = await newChat({ ownerId: lee, participants: [{ memberId: alice, roleId: 'prompter' }] })
  const leesChannel = await newChat({
    ownerId: lee,
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: alice, roleId: 'prompter' }],
  })
  expect(await transfer(aliceInAcme, leesChat, alice)).toEqual(
    failedWith('Only a chat whose owner left the workspace can be transferred'),
  )
  expect(await removeFromAcme(app, database, lee)).toEqual(succeeded)
  expect(await transfer(aliceInAcme, leesChat, bob)).toEqual(failedWith(`${bob} is not a member of this workspace`))
  expect(await sendTo(aliceInAcme, leesChat, `message-${crypto.randomUUID()}`, 'Anyone?')).toEqual(frozen)
  expect(await transfer(aliceInAcme, leesChat, alice)).toEqual(succeeded)
  expect([...(await database.$client`select owner_user_id from chats where id = ${leesChat}`)]).toEqual([
    { owner_user_id: alice },
  ])
  expect([
    ...(await database.$client`select user_id, role_id from chat_participants where chat_id = ${leesChat}`),
  ]).toEqual([{ user_id: alice, role_id: 'owner' }])
  expect((await changesOf(leesChat)).at(-1)).toMatchObject({
    type: 'chat.transferred',
    actor: alice,
    payload: { fromId: lee, toId: alice },
  })
  expect((await workspaceEventsOf(database)).at(-1)).toEqual({
    type: 'chat.transferred',
    actorId: alice,
    payload: { chatId: leesChat, fromId: lee, toId: alice },
  })
  expect(await sendTo(aliceInAcme, leesChat, `message-${crypto.randomUUID()}`, 'Back to work')).toEqual(succeeded)
  expect(await sendTo(aliceInAcme, leesChannel, `message-${crypto.randomUUID()}`, 'Still open')).toEqual(succeeded)
  expect(await transfer(aliceInAcme, leesChannel, alice)).toEqual(succeeded)
  expect([...(await database.$client`select owner_user_id from chats where id = ${leesChannel}`)]).toEqual([
    { owner_user_id: alice },
  ])
})

test('a removed member can be invited again with any role, and Alice still cannot demote herself', async () => {
  expect(await inviteToAcme(app, database, 'lee@example.com', 'admin')).toEqual(succeeded)
  expect(await invitationsOf('lee@example.com')).toEqual([expect.objectContaining({ role: 'admin', revoked_at: null })])
  expect(await changeRole(aliceInAcme, alice, 'member')).toEqual(ownMembership)
})
