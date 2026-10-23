import type { Transact, ZeroContext } from '@spyria/db/zero-queries'
import { chatId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { maximumMediaBytes, mediaKindOf } from '../domain/attachments.ts'
import { AttachmentTooLarge } from '../domain/errors.ts'
import { createTransactingZeroTransactor } from '../integrations/zero-transactor.ts'
import { uploadAttachment } from '../operations/upload-attachment.ts'

const questionAnswer = z.union([
  z.object({ approve: z.boolean() }),
  z.object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    free: z.optional(z.record(z.string(), z.string())),
  }),
])
export type QuestionAnswer = z.infer<typeof questionAnswer>
const planMode = z.object({ enabled: z.boolean() })

export const questionAnswerOf = (body: unknown) => questionAnswer.safeParse(body).data
export const planModeOf = (body: unknown) => planMode.safeParse(body).data

export const cappedBodyOf = async (request: Request, maximumBytes: number) => {
  if (Number(request.headers.get('content-length') ?? 0) > maximumBytes) throw new AttachmentTooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.length
    if (size > maximumBytes) throw new AttachmentTooLarge()
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export const uploadAttachmentFromRequest = (
  transact: Transact,
  context: ZeroContext,
  { chatId: rawChatId, name, request }: { chatId: string; name: string; request: Request },
) =>
  uploadAttachment(
    { transactor: createTransactingZeroTransactor(transact, context.workspaceId) },
    {
      id: crypto.randomUUID(),
      chatId: chatId(rawChatId),
      uploaderId: context.userId,
      name,
      readContent: () => cappedBodyOf(request, maximumMediaBytes),
    },
  )

export const mediaResponseOf = ({
  content,
  mediaType,
  name,
  isImmutable,
}: {
  content: Uint8Array<ArrayBuffer>
  mediaType: string
  name: string
  isImmutable: boolean
}) =>
  new Response(content, {
    headers: {
      'content-type': mediaType,
      'content-length': String(content.length),
      'content-disposition': `${mediaKindOf(mediaType) === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': isImmutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    },
  })
