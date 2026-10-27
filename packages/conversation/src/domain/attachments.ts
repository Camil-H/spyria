import { AttachmentNotAllowed, AttachmentStorageFull, TooManyPendingUploads } from './errors.ts'

export const maximumMediaBytes = 20 * 1024 * 1024
export const maximumAttachmentsPerMessage = 6
export const maximumPendingBytesPerMember = maximumAttachmentsPerMessage * maximumMediaBytes
export const maximumWorkspaceAttachmentBytes = 10 * 1024 * 1024 * 1024
const maximumNameLength = 120

export type MediaKind = 'image' | 'audio' | 'video' | 'file'
export type MediaFormat = Readonly<{ mediaType: string; kind: MediaKind }>
export type Attachment = Readonly<{ id: string; name: string; mediaType: string; size: number }>

const bytesOf = (signature: string) => [...signature].map((character) => character.charCodeAt(0))
const hasAt = (bytes: Uint8Array, offset: number, signature: string | number[]) =>
  (typeof signature === 'string' ? bytesOf(signature) : signature).every(
    (byte, index) => bytes[offset + index] === byte,
  )
const isMpegAudioFrame = (bytes: Uint8Array) =>
  bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && (((bytes[1] ?? 0) >> 1) & 0b11) === 0b01

const isoMediaFormatOf = (bytes: Uint8Array): MediaFormat =>
  hasAt(bytes, 8, 'M4A ')
    ? { mediaType: 'audio/mp4', kind: 'audio' }
    : hasAt(bytes, 8, 'qt  ')
      ? { mediaType: 'video/quicktime', kind: 'video' }
      : { mediaType: 'video/mp4', kind: 'video' }

export const mediaFormatOf = (bytes: Uint8Array): MediaFormat | undefined => {
  if (hasAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mediaType: 'image/png', kind: 'image' }
  if (hasAt(bytes, 0, [0xff, 0xd8, 0xff])) return { mediaType: 'image/jpeg', kind: 'image' }
  if (hasAt(bytes, 0, 'GIF87a') || hasAt(bytes, 0, 'GIF89a')) return { mediaType: 'image/gif', kind: 'image' }
  if (hasAt(bytes, 0, 'RIFF') && hasAt(bytes, 8, 'WEBP')) return { mediaType: 'image/webp', kind: 'image' }
  if (hasAt(bytes, 0, 'RIFF') && hasAt(bytes, 8, 'WAVE')) return { mediaType: 'audio/wav', kind: 'audio' }
  if (hasAt(bytes, 0, 'ID3') || isMpegAudioFrame(bytes)) return { mediaType: 'audio/mpeg', kind: 'audio' }
  if (hasAt(bytes, 0, 'OggS')) return { mediaType: 'audio/ogg', kind: 'audio' }
  if (hasAt(bytes, 0, 'fLaC')) return { mediaType: 'audio/flac', kind: 'audio' }
  if (hasAt(bytes, 4, 'ftyp')) return isoMediaFormatOf(bytes)
  if (hasAt(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { mediaType: 'video/webm', kind: 'video' }
  if (hasAt(bytes, 0, '%PDF-')) return { mediaType: 'application/pdf', kind: 'file' }
  return undefined
}

export const mediaKindOf = (mediaType: string): MediaKind => {
  const [family = ''] = mediaType.split('/')
  return family === 'image' || family === 'audio' || family === 'video' ? family : 'file'
}

export const allowedMediaFormatOf = (bytes: Uint8Array) => {
  if (bytes.length === 0 || bytes.length > maximumMediaBytes) throw new AttachmentNotAllowed()
  const format = mediaFormatOf(bytes)
  if (!format) throw new AttachmentNotAllowed()
  return format
}

export type StoredBytes = Readonly<{ pendingOfMember: number; inWorkspace: number }>

export const requireRoomFor = (size: number, stored: StoredBytes) => {
  if (stored.pendingOfMember + size > maximumPendingBytesPerMember) throw new TooManyPendingUploads()
  if (stored.inWorkspace + size > maximumWorkspaceAttachmentBytes) throw new AttachmentStorageFull()
}

export const allowedRuntimeMediaFormatOf = (bytes: Uint8Array) => {
  const format = allowedMediaFormatOf(bytes)
  if (format.kind === 'file') throw new AttachmentNotAllowed()
  return format
}

export const attachmentNameOf = (rawName: string) => {
  const baseName = rawName.split(/[\\/]/).at(-1) ?? ''
  const printable = baseName.replaceAll(/[\p{Cc}\p{Cf}"]/gu, '').trim()
  return printable.slice(0, maximumNameLength) || 'file'
}

export const fileSizeOf = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const chatAttachmentsPathOf = (chatId: string) => `/api/chats/${chatId}/attachments`
export const chatAttachmentPathOf = (chatId: string, attachmentId: string) =>
  `/api/chats/${chatId}/attachments/${attachmentId}`
export const chatMediaPathOf = (chatId: string) => `/api/chats/${chatId}/media`
export const isChatAttachmentPath = (path: string) => /^\/api\/chats\/[^/?]+\/attachments\/[^/?]+$/.test(path)

const runtimeVideoExtensions = /\.(mp4|m4v|webm|mov)$/i
const runtimeAudioExtensions = /\.(mp3|wav|ogg|oga|m4a|flac)$/i

export const isRuntimeMediaPath = (source: string) =>
  source !== '' && !/^[a-z][\w+.-]*:/i.test(source) && !source.startsWith('//') && !/[\\\0]/.test(source)

export const runtimeMediaKindOf = (path: string): MediaKind =>
  runtimeVideoExtensions.test(path) ? 'video' : runtimeAudioExtensions.test(path) ? 'audio' : 'image'
