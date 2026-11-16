import type { Element, ElementContent, Nodes } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { toMdast } from 'hast-util-to-mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'

export const copySkippedAttribute = 'data-copy-skip'

const textBlockTags = new Set(['blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'ul'])

const textOf = (node: Nodes): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const hasImage = (node: Nodes): boolean =>
  (node.type === 'element' && node.tagName === 'img') || ('children' in node && node.children.some(hasImage))

const isEmptyBlock = (element: Element) =>
  textBlockTags.has(element.tagName) && textOf(element).trim() === '' && !hasImage(element)

const copiedContentOf = (node: ElementContent): ElementContent[] => {
  if (node.type !== 'element') return [node]
  if (node.tagName === 'button' || node.properties.dataCopySkip !== undefined) return []
  const element = { ...node, children: node.children.flatMap(copiedContentOf) }
  return isEmptyBlock(element) ? [] : [element]
}

export const copiedSelectionOf = (tree: Element) => {
  const copied = { ...tree, children: tree.children.flatMap(copiedContentOf) }
  return {
    html: toHtml(copied),
    markdown: toMarkdown(
      toMdast(copied, {
        handlers: {
          u: (state, node) => [{ type: 'html', value: '__' }, ...state.all(node), { type: 'html', value: '__' }],
        },
      }),
      { bullet: '-', extensions: [gfmToMarkdown()], handlers: { break: () => '\n' } },
    ).trimEnd(),
  }
}
