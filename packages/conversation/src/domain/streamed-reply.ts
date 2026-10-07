export type StreamFrame = Readonly<{ promptId: string; text: string; isSnapshot?: boolean; isReasoning?: boolean }>
export type StoredFrame = Readonly<{ promptId: string; storedId: string }>
export type StreamedReply = Readonly<{
  promptId: string
  text: string
  repliesAtStart: number
  isReasoning?: boolean
  storedId?: string
}> | null

export const storedStreamedReply = (current: StreamedReply, { promptId, storedId }: StoredFrame): StreamedReply =>
  current?.promptId === promptId ? { ...current, storedId } : current

export const streamedReplyAfter = (
  current: StreamedReply,
  { promptId, text, isSnapshot, isReasoning = false }: StreamFrame,
  replyCountOf: (promptId: string) => number,
) => {
  const replies = replyCountOf(promptId)
  const continues =
    !isSnapshot &&
    current?.promptId === promptId &&
    current.repliesAtStart === replies &&
    current.storedId === undefined &&
    (current.isReasoning ?? false) === isReasoning
  return {
    promptId,
    text: continues ? current.text + text : text,
    repliesAtStart: replies,
    ...(isReasoning && { isReasoning }),
  }
}

export const visibleStreamedReply = (
  current: StreamedReply,
  replyCountOf: (promptId: string) => number,
  isStored: (messageId: string) => boolean = () => false,
) =>
  current &&
  current.text !== '' &&
  replyCountOf(current.promptId) === current.repliesAtStart &&
  !(current.storedId && isStored(current.storedId))
    ? current
    : null
