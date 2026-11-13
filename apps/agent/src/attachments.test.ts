import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  maximumInlineImageBytes,
  noPromptCapabilities,
  promptBlocksOf,
  promptCapabilitiesOf,
  saveAttachment,
} from './attachments.ts'

const directory = mkdtempSync(join(tmpdir(), 'spyria-attachments-test-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const savedPathOf = async (id: string, name: string, bytes: Uint8Array | string) => {
  const response = await saveAttachment(directory, { id, name, content: Buffer.from(bytes).toString('base64') })
  return String(((await response.json()) as { path: string }).path)
}
const attachmentBlock = (path: string, mimeType: string) => ({ type: 'attachment', path, mimeType })
const everyCapability = { image: true, audio: true }

test('an attachment is saved under its id with its own name, which can never leave its directory', async () => {
  const path = await savedPathOf('a1', 'photo.png', 'png bytes')
  expect(path).toBe(join(directory, 'a1', 'photo.png'))
  expect(await Bun.file(path).text()).toBe('png bytes')
  expect(await savedPathOf('a2', '../../escape.txt', 'x')).toBe(join(directory, 'a2', 'escape.txt'))
  expect(await savedPathOf('a3', '..\\..\\escape.txt', 'x')).toBe(join(directory, 'a3', 'escape.txt'))
  expect(await savedPathOf('a4', '..', 'x')).toBe(join(directory, 'a4', 'file'))
})

test('a name longer than a file name may be is cut to 255 bytes on a character boundary, keeping its extension', async () => {
  const path = await savedPathOf('a5', `${'会'.repeat(120)}.pdf`, 'x')
  const fileName = path.split('/').at(-1) ?? ''
  expect(fileName).toBe(`${'会'.repeat(83)}.pdf`)
  expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255)
  expect(await Bun.file(path).text()).toBe('x')
})

test.each([{ id: '../a', content: 'eA==' }, { id: 'a/b', content: 'eA==' }, { id: '', content: 'eA==' }, { id: 'a1' }])(
  'an attachment with an id that is not a plain token or without content is refused: %p',
  async (body) => {
    expect((await saveAttachment(directory, { ...body, name: 'x.png' })).status).toBe(400)
  },
)

test('a harness declares which attachments it reads in its prompt capabilities, and reads none when it declares nothing', () => {
  expect(
    promptCapabilitiesOf({ agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } }),
  ).toEqual({ image: true, audio: false })
  expect(promptCapabilitiesOf({})).toEqual(noPromptCapabilities)
})

test('an image or a sound is given to the harness inline when it reads that kind, after the text, and a PDF or a video only as its path', async () => {
  const image = await savedPathOf('i1', 'photo.png', 'image')
  const pdf = await savedPathOf('p1', 'report.pdf', 'pdf')
  const audio = await savedPathOf('s1', 'song.mp3', 'audio')
  const video = await savedPathOf('v1', 'clip.mp4', 'video')
  const content = [
    attachmentBlock(image, 'image/png'),
    { type: 'text', text: 'What is this?' },
    attachmentBlock(pdf, 'application/pdf'),
    attachmentBlock(audio, 'audio/mpeg'),
    attachmentBlock(video, 'video/mp4'),
  ]
  expect(await promptBlocksOf(directory, content, everyCapability)).toEqual([
    { type: 'text', text: 'What is this?' },
    { type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') },
    { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('audio').toString('base64') },
  ])
  expect(await promptBlocksOf(directory, content, noPromptCapabilities)).toEqual([
    { type: 'text', text: 'What is this?' },
  ])
})

test('an image over the size models accept, or a path outside the attachments, stays out of the prompt', async () => {
  const large = await savedPathOf('l1', 'large.png', new Uint8Array(maximumInlineImageBytes + 1))
  const outside = join(directory, '..', 'outside.png')
  expect(
    await promptBlocksOf(
      directory,
      [
        attachmentBlock(large, 'image/png'),
        attachmentBlock(outside, 'image/png'),
        attachmentBlock(directory, 'image/png'),
      ],
      everyCapability,
    ),
  ).toEqual([])
})
