import { fromMarkdown } from 'mdast-util-from-markdown'

type OutlinedNode = {
  type: string
  identifier?: string
  url?: string
  title?: string | null
  children?: OutlinedNode[]
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

const escaped = (text: string, characters: RegExp) => text.replace(characters, (character) => `\\${character}`)

const definitionSourceOf = ({ identifier = '', url = '', title }: OutlinedNode) =>
  `[${identifier}]: <${escaped(url, /[\\<>&]/g)}>${title ? ` "${escaped(title, /[\\"&]/g)}"` : ''}`

const definitionSourcesOf = (text: string) =>
  nodesOf(fromMarkdown(text)).flatMap((node) =>
    node.type === 'definition' && !node.identifier?.startsWith('^') ? [definitionSourceOf(node)] : [],
  )

const shownImageCountOf = (text: string) => nodesOf(fromMarkdown(text)).filter(isShownImage).length

const completedDefinitionSourcesOf = cachedBy(definitionSourcesOf)
const completedShownImageCountOf = cachedBy(shownImageCountOf)

export const withDefinitionsShared = <Block extends { text: string }>(completed: readonly Block[], tail: Block) => {
  const definitionSources = completed.flatMap((block) => completedDefinitionSourcesOf(block.text))
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
