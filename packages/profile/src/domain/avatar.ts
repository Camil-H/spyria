import type { Brand } from '@spyria/kernel'
import { InvalidAvatar } from './errors.ts'

export type Avatar = Brand<'Avatar'>

export const avatarPixels = 96
export const maximumAvatarLength = 16_000

const dataUrlPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/
const headerCharacters = 16

const headerBytesOf = (base64: string) =>
  [...atob(base64.slice(0, headerCharacters))].map((character) => character.charCodeAt(0))

const startsWith = (bytes: readonly number[], signature: readonly number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

const asciiOf = (text: string) => [...text].map((character) => character.charCodeAt(0))

const hasSignatureOf = (format: string, bytes: readonly number[]) =>
  format === 'png'
    ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : format === 'jpeg'
      ? startsWith(bytes, [0xff, 0xd8, 0xff])
      : startsWith(bytes, asciiOf('RIFF')) && startsWith(bytes, asciiOf('WEBP'), 8)

export const Avatar = (rawValue: string): Avatar => {
  const [, format = '', base64 = ''] =
    rawValue.length <= maximumAvatarLength ? (dataUrlPattern.exec(rawValue) ?? []) : []
  if (base64.length < headerCharacters || !hasSignatureOf(format, headerBytesOf(base64))) throw new InvalidAvatar()
  return rawValue as Avatar
}
