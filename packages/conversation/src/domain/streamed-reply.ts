export type StreamFrame = Readonly<{ promptId: string; text: string; isSnapshot?: boolean }>
export type StreamedReply = Readonly<{ promptId: string; text: string; repliesAtStart: number }> | null

export const streamedReplyAfter = (
  current: StreamedReply,
  { promptId, text, isSnapshot }: StreamFrame,
  replyCountOf: (promptId: string) => number,
) => {
  const replies = replyCountOf(promptId)
  const continues = !isSnapshot && current?.promptId === promptId && current.repliesAtStart === replies
  return { promptId, text: continues ? current.text + text : text, repliesAtStart: replies }
}

export const visibleStreamedReply = (current: StreamedReply, replyCountOf: (promptId: string) => number) =>
  current && current.text !== '' && replyCountOf(current.promptId) === current.repliesAtStart ? current : null
