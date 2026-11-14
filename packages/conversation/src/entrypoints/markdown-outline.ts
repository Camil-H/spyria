import { fromMarkdown } from 'mdast-util-from-markdown'

export type OutlinedNode = {
  type: string
  identifier?: string
  children?: OutlinedNode[]
  position?: { start: { offset?: number }; end?: { offset?: number } }
}

const maximumCachedBlocks = 500

const cachedBy = <Value>(compute: (text: string) => Value) => {
  const valueByText = new Map<string, Value>()
  return (text: string) => {
    const known = valueByText.get(text)
    if (known !== undefined) return known
    if (valueByText.size >= maximumCachedBlocks) valueByText.clear()
    const value = compute(text)
    valueByText.set(text, value)
    return value
  }
}

const nodesOf = (node: OutlinedNode): OutlinedNode[] => [node, ...(node.children ?? []).flatMap(nodesOf)]

export const isShownImage = (node: OutlinedNode) => node.type === 'image' || node.type === 'imageReference'

const definitionSourcesOf = (text: string) =>
  nodesOf(fromMarkdown(text)).flatMap(({ type, identifier, position }) =>
    type === 'definition' && !identifier?.startsWith('^')
      ? [text.slice(position?.start.offset, position?.end?.offset)]
      : [],
  )

const shownImageCountOf = (text: string) => nodesOf(fromMarkdown(text)).filter(isShownImage).length

const completedDefinitionSourcesOf = cachedBy(definitionSourcesOf)
const completedShownImageCountOf = cachedBy(shownImageCountOf)

export const withDefinitionsShared = <Block extends { text: string }>(completed: readonly Block[], tail: Block) => {
  const definitionSources = [
    ...completed.flatMap((block) => completedDefinitionSourcesOf(block.text)),
    ...definitionSourcesOf(tail.text),
  ]
  const definitionsBefore = definitionSources.length > 0 ? `${definitionSources.join('\n')}\n\n` : ''
  return [
    ...completed.map((block) => ({
      ...block,
      text: definitionsBefore + block.text,
      shownImages: completedShownImageCountOf(definitionsBefore + block.text),
    })),
    { ...tail, text: definitionsBefore + tail.text, shownImages: shownImageCountOf(definitionsBefore + tail.text) },
  ]
}
