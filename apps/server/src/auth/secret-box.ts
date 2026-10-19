const minimumSecretsKeyLength = 32
const encoder = new TextEncoder()

export const createSecretBox = (secretsKey: string) => {
  if (secretsKey.length < minimumSecretsKeyLength)
    throw new Error(`SPYRIA_SECRETS_KEY must be at least ${minimumSecretsKeyLength} characters`)
  const key = crypto.subtle
    .digest('SHA-256', encoder.encode(secretsKey))
    .then((digest) => crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']))
  return {
    seal: async (plaintext: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, encoder.encode(plaintext))
      return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(sealed).toString('base64url')}`
    },
    open: async (sealed: string) => {
      const [iv = '', data = ''] = sealed.split('.')
      const opened = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(iv, 'base64url') },
        await key,
        Buffer.from(data, 'base64url'),
      )
      return new TextDecoder().decode(opened)
    },
  }
}

export type SecretBox = ReturnType<typeof createSecretBox>
