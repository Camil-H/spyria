import { createHash, createHmac } from 'node:crypto'

const minimumSecretsKeyLength = 32
const keyIdLength = 12
const encoder = new TextEncoder()

export class UnknownSecretsKey extends Error {
  constructor(readonly keyId: string) {
    super(`No key of SPYRIA_SECRETS_KEY or SPYRIA_PREVIOUS_SECRETS_KEYS has the id ${keyId}`)
  }
}

const keyIdOf = (secretsKey: string) =>
  createHash('sha256').update(`spyria-secrets-key-id.${secretsKey}`).digest('base64url').slice(0, keyIdLength)

export const secretsKeyringOf = (currentKey: string, previousKeys: readonly string[] = []) => {
  for (const key of [currentKey, ...previousKeys])
    if (key.length < minimumSecretsKeyLength)
      throw new Error(
        `SPYRIA_SECRETS_KEY and each of SPYRIA_PREVIOUS_SECRETS_KEYS must be at least ${minimumSecretsKeyLength} characters`,
      )
  const keyById = new Map([currentKey, ...previousKeys].map((key) => [keyIdOf(key), key]))
  const keyOf = (keyId: string) => {
    const key = keyById.get(keyId)
    if (key === undefined) throw new UnknownSecretsKey(keyId)
    return key
  }
  return {
    currentKeyId: keyIdOf(currentKey),
    keyOf,
    derivedKeyOf: (keyId: string, purpose: string) =>
      createHmac('sha256', keyOf(keyId)).update(purpose).digest('base64url'),
  }
}

export type SecretsKeyring = ReturnType<typeof secretsKeyringOf>

export const secretsKeyringFrom = (environment: Record<string, string | undefined>) => {
  const currentKey = environment.SPYRIA_SECRETS_KEY
  if (!currentKey) throw new Error('SPYRIA_SECRETS_KEY is required')
  const previousKeys = (environment.SPYRIA_PREVIOUS_SECRETS_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  return secretsKeyringOf(currentKey, previousKeys)
}

export const createSecretBox = (keyring: SecretsKeyring) => {
  const cipherKeys = new Map<string, Promise<CryptoKey>>()
  const cipherKeyOf = (keyId: string) => {
    const secretsKey = keyring.keyOf(keyId)
    const cipherKey =
      cipherKeys.get(keyId) ??
      crypto.subtle
        .digest('SHA-256', encoder.encode(secretsKey))
        .then((digest) => crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']))
    cipherKeys.set(keyId, cipherKey)
    return cipherKey
  }
  const seal = async (plaintext: string) => {
    const keyId = keyring.currentKeyId
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(keyId) },
      await cipherKeyOf(keyId),
      encoder.encode(plaintext),
    )
    return `${keyId}.${Buffer.from(iv).toString('base64url')}.${Buffer.from(sealed).toString('base64url')}`
  }
  const open = async (sealed: string) => {
    const [keyId = '', iv = '', data = ''] = sealed.split('.')
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: encoder.encode(keyId) },
      await cipherKeyOf(keyId),
      Buffer.from(data, 'base64url'),
    )
    return new TextDecoder().decode(opened)
  }
  return {
    seal,
    open,
    isSealedWithCurrentKey: (sealed: string) => sealed.startsWith(`${keyring.currentKeyId}.`),
    reseal: async (sealed: string) => seal(await open(sealed)),
  }
}

export type SecretBox = ReturnType<typeof createSecretBox>
