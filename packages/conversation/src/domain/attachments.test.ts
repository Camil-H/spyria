import { expect, test } from 'bun:test'
import {
  allowedMediaFormatOf,
  attachmentNameOf,
  fileSizeOf,
  isRuntimeMediaPath,
  maximumMediaBytes,
  mediaFormatOf,
  runtimeMediaKindOf,
} from './attachments.ts'
import { AttachmentNotAllowed } from './errors.ts'

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)))

test('the format comes from the first bytes, never from the name or the browser', () => {
  expect(mediaFormatOf(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0]))?.mediaType).toBe('image/png')
  expect(mediaFormatOf(bytes([0xff, 0xd8, 0xff, 0xe0]))?.mediaType).toBe('image/jpeg')
  expect(mediaFormatOf(bytes('GIF89a'))?.mediaType).toBe('image/gif')
  expect(mediaFormatOf(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))?.mediaType).toBe('image/webp')
  expect(mediaFormatOf(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))?.mediaType).toBe('audio/wav')
  expect(mediaFormatOf(bytes('ID3', [4, 0]))?.mediaType).toBe('audio/mpeg')
  expect(mediaFormatOf(bytes([0xff, 0xfb, 0x90, 0x00]))?.mediaType).toBe('audio/mpeg')
  expect(mediaFormatOf(bytes('OggS'))?.mediaType).toBe('audio/ogg')
  expect(mediaFormatOf(bytes('fLaC'))?.mediaType).toBe('audio/flac')
  expect(mediaFormatOf(bytes([0, 0, 0, 32], 'ftypisom'))).toEqual({ mediaType: 'video/mp4', kind: 'video' })
  expect(mediaFormatOf(bytes([0, 0, 0, 32], 'ftypM4A '))).toEqual({ mediaType: 'audio/mp4', kind: 'audio' })
  expect(mediaFormatOf(bytes([0, 0, 0, 20], 'ftypqt  '))?.mediaType).toBe('video/quicktime')
  expect(mediaFormatOf(bytes([0x1a, 0x45, 0xdf, 0xa3]))?.mediaType).toBe('video/webm')
  expect(mediaFormatOf(bytes('%PDF-1.7'))).toEqual({ mediaType: 'application/pdf', kind: 'file' })
})

test('scriptable or unknown formats are refused: SVG, HTML, executables, plain text', () => {
  for (const refused of ['<svg xmlns="http://www.w3.org/2000/svg">', '<!doctype html>', 'MZ\x90\x00', 'hello'])
    expect(() => allowedMediaFormatOf(bytes(refused))).toThrow(AttachmentNotAllowed)
})

test('an empty file and a file over the cap are refused', () => {
  expect(() => allowedMediaFormatOf(new Uint8Array())).toThrow(AttachmentNotAllowed)
  const oversized = new Uint8Array(maximumMediaBytes + 1)
  oversized.set(bytes('GIF89a'))
  expect(() => allowedMediaFormatOf(oversized)).toThrow(AttachmentNotAllowed)
  expect(allowedMediaFormatOf(oversized.subarray(0, maximumMediaBytes)).kind).toBe('image')
})

test('a name keeps only its last path part, without control characters or quotes', () => {
  expect(attachmentNameOf('C:\\Users\\me\\photo.png')).toBe('photo.png')
  expect(attachmentNameOf('../../etc/passwd')).toBe('passwd')
  expect(attachmentNameOf('re\u202Egnp.exe"\n')).toBe('regnp.exe')
  expect(attachmentNameOf('')).toBe('file')
  expect(attachmentNameOf('a'.repeat(300))).toHaveLength(120)
})

test('sizes read in plain units', () => {
  expect(fileSizeOf(900)).toBe('900 B')
  expect(fileSizeOf(150 * 1024)).toBe('150 KB')
  expect(fileSizeOf(3.25 * 1024 * 1024)).toBe('3.3 MB')
})

test('a runtime media path is a path in the workspace, never a URL', () => {
  expect(isRuntimeMediaPath('out/chart.png')).toBe(true)
  expect(isRuntimeMediaPath('/workspace/project/chart.png')).toBe(true)
  for (const url of ['https://example.com/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', '//cdn/a.png', ''])
    expect(isRuntimeMediaPath(url)).toBe(false)
  expect(runtimeMediaKindOf('demo.MP4')).toBe('video')
  expect(runtimeMediaKindOf('voice.m4a')).toBe('audio')
  expect(runtimeMediaKindOf('chart.png')).toBe('image')
})
