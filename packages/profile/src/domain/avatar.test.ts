import { expect, test } from 'bun:test'
import { Avatar, maximumAvatarLength } from './avatar.ts'
import { InvalidAvatar } from './errors.ts'

const dataUrlOf = (mediaType: string, bytes: readonly number[]) =>
  `data:${mediaType};base64,${btoa(String.fromCharCode(...bytes, ...Array(32).fill(0)))}`
const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0))
const png = dataUrlOf('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpeg = dataUrlOf('image/jpeg', [0xff, 0xd8, 0xff, 0xe0])
const webp = dataUrlOf('image/webp', [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])

test('Avatar accepts a PNG, JPEG or WebP data URL whose bytes match its type', () => {
  for (const image of [png, jpeg, webp]) expect(String(Avatar(image))).toBe(image)
})

test.each([
  ['a PNG declared as JPEG', png.replace('image/png', 'image/jpeg')],
  ['an SVG', `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')}`],
  ['a web address', 'https://example.com/me.png'],
  ['text after the image', `${png}"><script>`],
  ['an image too large to sync to every member', `${png}${'A'.repeat(maximumAvatarLength)}`],
  ['an empty image', 'data:image/png;base64,'],
])('Avatar refuses %s', (_, rawValue) => {
  expect(() => Avatar(rawValue)).toThrow(InvalidAvatar)
})
