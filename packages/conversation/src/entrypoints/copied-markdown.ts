import type { Nodes } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { toMdast } from 'hast-util-to-mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'

export const copySkippedAttribute = 'data-copy-skip'

const isCopied = (node: Nodes) =>
  node.type !== 'element' || (node.tagName !== 'button' && node.properties.dataCopySkip === undefined)

const withoutCopySkipped = (node: Nodes): Nodes =>
  'children' in node ? ({ ...node, children: node.children.filter(isCopied).map(withoutCopySkipped) } as Nodes) : node

export const copiedSelectionOf = (tree: Nodes) => {
  const copied = withoutCopySkipped(tree)
  return {
    html: toHtml(copied),
    markdown: toMarkdown(toMdast(copied), {
      bullet: '-',
      extensions: [gfmToMarkdown()],
      handlers: { break: () => '\n' },
    }).trimEnd(),
  }
}
