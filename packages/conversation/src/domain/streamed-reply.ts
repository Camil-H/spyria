export type StreamFrame = Readonly<{ promptId: string; text: string; isSnapshot?: boolean; isReasoning?: boolean }>
export type StreamedReply = Readonly<{
  promptId: string
  text: string
  repliesAtStart: number
  isReasoning?: boolean
}> | null

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
    (current.isReasoning ?? false) === isReasoning
  return {
    promptId,
    text: continues ? current.text + text : text,
    repliesAtStart: replies,
    ...(isReasoning && { isReasoning }),
  }
}

export const visibleStreamedReply = (current: StreamedReply, replyCountOf: (promptId: string) => number) =>
  current && current.text !== '' && replyCountOf(current.promptId) === current.repliesAtStart ? current : null
