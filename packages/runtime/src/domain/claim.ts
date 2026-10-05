import { CodeAlreadyUsed, CodeExpired, HostRemoved } from './errors.ts'

export const claimCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const claimLifetimeMilliseconds = 15 * 60_000
const claimCodeLength = 8
const unbiasedByteLimit = 256 - (256 % claimCodeAlphabet.length)

export const newClaimCode = () => {
  let code = ''
  while (code.length < claimCodeLength)
    for (const byte of crypto.getRandomValues(new Uint8Array(claimCodeLength * 2)))
      if (byte < unbiasedByteLimit && code.length < claimCodeLength)
        code += claimCodeAlphabet[byte % claimCodeAlphabet.length]
  return code
}

export const newHostToken = () =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true })

export const hashSecret = async (secret: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))).toHex()

export const isClaimExpired = (claimExpiresAt: number, now: number) => now >= claimExpiresAt

export const claimRefusal = (
  claim: { removedAt: number | null; claimed: boolean; claimExpiresAt: number | null },
  now: number,
) => {
  if (claim.removedAt !== null) return new HostRemoved()
  if (claim.claimed) return new CodeAlreadyUsed()
  if (claim.claimExpiresAt === null || isClaimExpired(claim.claimExpiresAt, now)) return new CodeExpired()
  return undefined
}
