import { expect, test } from 'bun:test'
import { createSecretBox, secretsKeyringFrom, secretsKeyringOf, UnknownSecretsKey } from './secret-box.ts'

const previousKey = 'previous-secrets-key-0123456789abcdef'
const currentKey = 'current-secrets-key-0123456789abcdefgh'
const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

test('a value sealed with a previous key still opens after the rotation, and seals again under the current key', async () => {
  const sealedBefore = await createSecretBox(secretsKeyringOf(previousKey)).seal('client-secret')
  const rotated = createSecretBox(secretsKeyringOf(currentKey, [previousKey]))

  expect(await rotated.open(sealedBefore)).toBe('client-secret')
  expect(rotated.isSealedWithCurrentKey(sealedBefore)).toBe(false)
  const resealed = await rotated.reseal(sealedBefore)
  expect(rotated.isSealedWithCurrentKey(resealed)).toBe(true)
  expect(await createSecretBox(secretsKeyringOf(currentKey)).open(resealed)).toBe('client-secret')
})

const sealedWithoutKeyId = async (secretsKey: string, plaintext: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secretsKey))
  const cipherKey = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cipherKey, new TextEncoder().encode(plaintext))
  return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(sealed).toString('base64url')}`
}

test('a value sealed before sealed values named their key opens with the current or a previous key, and seals again under the current key', async () => {
  const box = createSecretBox(secretsKeyringOf(currentKey, [previousKey]))
  const sealedWithCurrent = await sealedWithoutKeyId(currentKey, 'github-token')
  const sealedWithPrevious = await sealedWithoutKeyId(previousKey, 'client-secret')

  expect(await box.open(sealedWithCurrent)).toBe('github-token')
  expect(await box.open(sealedWithPrevious)).toBe('client-secret')
  expect(box.isSealedWithCurrentKey(sealedWithCurrent)).toBe(false)
  const resealed = await box.reseal(sealedWithCurrent)
  expect(box.isSealedWithCurrentKey(resealed)).toBe(true)
  expect(await box.open(resealed)).toBe('github-token')
})

test('a value sealed before sealed values named their key, with a key no longer in the keyring, is refused', async () => {
  const sealed = await sealedWithoutKeyId(previousKey, 'client-secret')

  expect(await errorOf(createSecretBox(secretsKeyringOf(currentKey)).open(sealed))).toBeInstanceOf(UnknownSecretsKey)
})

test('a value sealed with a key no longer in the keyring is refused with the id of that key', async () => {
  const keyring = secretsKeyringOf(previousKey)
  const sealed = await createSecretBox(keyring).seal('client-secret')

  const refusal = await errorOf(createSecretBox(secretsKeyringOf(currentKey)).open(sealed))

  expect(refusal).toBeInstanceOf(UnknownSecretsKey)
  expect(refusal).toMatchObject({ keyId: keyring.currentKeyId })
  expect(String(refusal)).not.toContain(previousKey)
})

test('a sealed value relabelled with another key id of the keyring does not open', async () => {
  const keyring = secretsKeyringOf(currentKey, [previousKey])
  const box = createSecretBox(keyring)
  const [, iv, data] = (await box.seal('client-secret')).split('.')
  const previousKeyId = secretsKeyringOf(previousKey).currentKeyId

  expect(await errorOf(box.open(`${previousKeyId}.${iv}.${data}`))).toBeInstanceOf(Error)
})

test('each key derives its own stable runtime key, and the key id never reveals the key', () => {
  const rotated = secretsKeyringOf(currentKey, [previousKey])
  const previous = secretsKeyringOf(previousKey)

  expect(rotated.derivedKeyOf(previous.currentKeyId, 'runtime')).toBe(
    previous.derivedKeyOf(previous.currentKeyId, 'runtime'),
  )
  expect(rotated.derivedKeyOf(rotated.currentKeyId, 'runtime')).not.toBe(
    rotated.derivedKeyOf(previous.currentKeyId, 'runtime'),
  )
  expect(rotated.currentKeyId).toMatch(/^[A-Za-z0-9_-]{12}$/)
  expect(currentKey).not.toContain(rotated.currentKeyId)
  expect(() => rotated.derivedKeyOf('unknown-key', 'runtime')).toThrow(UnknownSecretsKey)
})

test('the keyring reads the current key and the comma-separated previous keys, and refuses a short one', () => {
  const keyring = secretsKeyringFrom({
    SPYRIA_SECRETS_KEY: currentKey,
    SPYRIA_PREVIOUS_SECRETS_KEYS: ` ${previousKey} ,`,
  })

  expect(keyring.currentKeyId).toBe(secretsKeyringOf(currentKey).currentKeyId)
  expect(keyring.keyOf(secretsKeyringOf(previousKey).currentKeyId)).toBe(previousKey)
  expect(() => secretsKeyringFrom({})).toThrow('SPYRIA_SECRETS_KEY is required')
  expect(() => secretsKeyringOf(currentKey, ['too-short'])).toThrow('at least 32 characters')
})
