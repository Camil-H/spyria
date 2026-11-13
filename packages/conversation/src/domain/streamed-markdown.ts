export type StreamedBlock = { offset: number; text: string }

const openingFenceOf = (line: string) => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

const isClosingFence = (line: string, fence: string) =>
  new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)

export const imageCountOf = (markdown: string) => markdown.match(/!\[/g)?.length ?? 0

export const streamedBlocksOf = (text: string) => {
  const lines = text.split('\n')
  const completed: StreamedBlock[] = []
  let blockStart = 0
  let offset = 0
  let openFence: string | undefined
  for (const [index, line] of lines.slice(0, -1).entries()) {
    const nextOffset = offset + line.length + 1
    if (openFence) {
      if (isClosingFence(line, openFence)) openFence = undefined
    } else {
      openFence = openingFenceOf(line)
      if (!openFence && line.trim() === '' && /^\S/.test(lines[index + 1] ?? '')) {
        const block = text.slice(blockStart, offset - 1)
        if (block.trim() !== '') completed.push({ offset: blockStart, text: block })
        blockStart = nextOffset
      }
    }
    offset = nextOffset
  }
  return { completed, tail: { offset: blockStart, text: text.slice(blockStart) } }
}
