import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'

export type PromptCapabilities = Readonly<{ image: boolean; audio: boolean }>
export type PromptBlock = { type?: string; text?: string; path?: string; mimeType?: string }
type SavedAttachment = { id?: unknown; name?: unknown; content?: unknown }

export const noPromptCapabilities: PromptCapabilities = { image: false, audio: false }
export const maximumInlineImageBytes = 3_750_000
const maximumFileNameBytes = 255
const attachmentIdFormat = /^[\w-]{1,64}$/

export const promptCapabilitiesOf = (initialized: Record<string, unknown>): PromptCapabilities => {
  const declared = (initialized.agentCapabilities as { promptCapabilities?: Record<string, unknown> } | undefined)
    ?.promptCapabilities
  return { image: declared?.image === true, audio: declared?.audio === true }
}

const fittedFileNameOf = (fileName: string) => {
  const extension = extname(fileName)
  const stem = Array.from(fileName.slice(0, fileName.length - extension.length))
  while (stem.length > 0 && Buffer.byteLength(stem.join('') + extension) > maximumFileNameBytes) stem.pop()
  return stem.length > 0 ? stem.join('') + extension : 'file'
}

const fileNameOf = (name: string) => {
  const fileName = basename(name.replaceAll('\\', '/')).replaceAll('\0', '')
  return fileName === '' || fileName === '.' || fileName === '..' ? 'file' : fittedFileNameOf(fileName)
}

export const saveAttachment = async (directory: string, { id, name, content }: SavedAttachment) => {
  if (typeof id !== 'string' || !attachmentIdFormat.test(id) || typeof content !== 'string')
    return Response.json({ error: 'The attachment needs an id and a content' }, { status: 400 })
  const path = join(directory, id, fileNameOf(typeof name === 'string' ? name : ''))
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, Buffer.from(content, 'base64'))
  return Response.json({ path })
}

const isInside = (directory: string, path: string) => {
  const inside = relative(directory, path)
  return inside !== '' && !inside.startsWith('..') && !inside.startsWith('/')
}

const inlineBlockOf = async (
  directory: string,
  { path = '', mimeType = '' }: PromptBlock,
  capabilities: PromptCapabilities,
) => {
  if (!isInside(directory, path)) return undefined
  const isImage = mimeType.startsWith('image/') && capabilities.image
  const isAudio = mimeType.startsWith('audio/') && capabilities.audio
  if (!isImage && !isAudio) return undefined
  const size = (await stat(path).catch(() => undefined))?.size
  if (size === undefined || (isImage && size > maximumInlineImageBytes)) return undefined
  return {
    type: isImage ? 'image' : 'audio',
    mimeType,
    data: Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64'),
  }
}

export const promptBlocksOf = async (
  directory: string,
  content: readonly PromptBlock[],
  capabilities: PromptCapabilities,
) => {
  const texts = content.filter((block) => block.type === 'text').map(({ text }) => ({ type: 'text', text }))
  const inlined = await Promise.all(
    content
      .filter((block) => block.type === 'attachment')
      .map((block) => inlineBlockOf(directory, block, capabilities)),
  )
  return [...texts, ...inlined.filter((block) => block !== undefined)]
}
