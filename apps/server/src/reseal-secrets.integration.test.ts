import { expect, test } from 'bun:test'
import { createSecretBox, secretsKeyringOf, UnknownSecretsKey } from './auth/secret-box.ts'
import { countRuntimesRunningOnPreviousKeys, resealSecrets } from './reseal-secrets.ts'
import {
  acme,
  alice,
  bob,
  globex,
  openSharedTestApp,
  rejectionOf,
  testSecretsKey,
  testSpyriaAgentImage,
} from './testing/testing.ts'

const { database } = await openSharedTestApp()
const sql = database.$client
const currentKey = 'rotated-reseal-secrets-key-0123456789'
const previousBox = createSecretBox(secretsKeyringOf(testSecretsKey))
const rotatedKeyring = secretsKeyringOf(currentKey, [testSecretsKey])
const rotatedBox = createSecretBox(rotatedKeyring)
const currentOnlyBox = createSecretBox(secretsKeyringOf(currentKey))

const storeSealedSecrets = async () => {
  await sql`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at) values
      (${acme}, 'oidc', 'https://idp.example.com', 'spyria-acme', ${await previousBox.seal('sso-secret')}, now()),
      (${globex}, 'google', 'https://accounts.google.com', 'instance-app', '', now())
    on conflict (workspace_id) do update set encrypted_client_secret = excluded.encrypted_client_secret`
  await sql`
    insert into github_apps (workspace_id, app_id, client_id, encrypted_client_secret, encrypted_private_key,
      encrypted_webhook_secret, updated_at)
    values (${acme}, '1', 'client', ${await previousBox.seal('app-secret')}, ${await previousBox.seal('private-key')},
      ${await rotatedBox.seal('webhook-secret')}, now())
    on conflict (workspace_id) do update set encrypted_client_secret = excluded.encrypted_client_secret,
      encrypted_private_key = excluded.encrypted_private_key, encrypted_webhook_secret = excluded.encrypted_webhook_secret`
  await sql`
    insert into github_connections (workspace_id, user_id, login, encrypted_access_token, encrypted_refresh_token,
      needs_reconnection, updated_at) values
      (${acme}, ${alice}, 'alice', ${await previousBox.seal('alice-access')}, ${await previousBox.seal('alice-refresh')}, false, now()),
      (${acme}, ${bob}, 'bob', ${await previousBox.seal('bob-access')}, null, false, now())
    on conflict (workspace_id, user_id) do update set encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token`
}

const storedSecrets = async () => {
  const [sso] = await sql`select encrypted_client_secret from workspace_sso where workspace_id = ${acme}`
  const [app] = await sql`
    select encrypted_client_secret, encrypted_private_key, encrypted_webhook_secret from github_apps
    where workspace_id = ${acme}`
  const connections = await sql`
    select encrypted_access_token, encrypted_refresh_token from github_connections
    where workspace_id = ${acme} and user_id in (${alice}, ${bob}) order by user_id`
  return [sso, app, ...connections].flatMap((row) => Object.values(row ?? {})).filter((value) => value !== null)
}

test('resealing opens every stored secret sealed with a previous key and seals it with the current key, once', async () => {
  await storeSealedSecrets()

  expect(await resealSecrets(database, rotatedBox)).toBe(6)

  const stored = await storedSecrets()
  expect(stored.every((sealed) => rotatedBox.isSealedWithCurrentKey(String(sealed)))).toBe(true)
  expect(await Promise.all(stored.map((sealed) => currentOnlyBox.open(String(sealed))))).toEqual([
    'sso-secret',
    'app-secret',
    'private-key',
    'webhook-secret',
    'alice-access',
    'alice-refresh',
    'bob-access',
  ])
  const [instanceApp] = await sql`select encrypted_client_secret from workspace_sso where workspace_id = ${globex}`
  expect(instanceApp?.encrypted_client_secret).toBe('')
  expect(await resealSecrets(database, rotatedBox)).toBe(0)
})

test('resealing without the key a secret was sealed with stops and names that key, leaving the secret as it was', async () => {
  await storeSealedSecrets()
  const before = await storedSecrets()

  const refusal = await rejectionOf(resealSecrets(database, currentOnlyBox))

  expect(refusal).toBeInstanceOf(UnknownSecretsKey)
  expect(refusal).toMatchObject({ keyId: secretsKeyringOf(testSecretsKey).currentKeyId })
  expect(await storedSecrets()).toEqual(before)
})

test('only running runtimes on a key other than the current one count as still needing a previous key', async () => {
  await sql`
    insert into runtime_hosts (workspace_id, id, name, status, running_runtimes, created_by, owner_id, created_at)
    values (${acme}, 'host-reseal', 'host-reseal', 'online', 0, ${alice}, null, now())`
  const runtimes = [
    { state: 'running', apiKeyId: secretsKeyringOf(testSecretsKey).currentKeyId },
    { state: 'running', apiKeyId: rotatedKeyring.currentKeyId },
    { state: 'stopped', apiKeyId: secretsKeyringOf(testSecretsKey).currentKeyId },
  ]
  for (const [index, { state, apiKeyId }] of runtimes.entries()) {
    const chatId = `chat-reseal-${index}`
    await sql`
      insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, archived, created_at)
      values (${acme}, ${chatId}, 'runtime', 'private', 'user', ${alice}, ${chatId}, false, now())`
    await sql`
      insert into runtimes (workspace_id, id, chat_id, host_id, state, host_online, image, api_key_id, last_active_at,
        created_at, state_changed_at)
      values (${acme}, ${`runtime-reseal-${index}`}, ${chatId}, 'host-reseal', ${state}, true, ${testSpyriaAgentImage},
        ${apiKeyId}, now(), now(), now())`
  }

  expect(await countRuntimesRunningOnPreviousKeys(database, rotatedKeyring.currentKeyId)).toBe(1)
})
