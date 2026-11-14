import { expect, test } from 'bun:test'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { withDefinitionsShared } from './markdown-outline.ts'

const blocksWhileTailIs = (tail: string) =>
  withDefinitionsShared(
    [
      { offset: 0, text: 'See [the docs][docs] and ![Chart][chart].' },
      { offset: 44, text: '[chart]: out/chart.png' },
    ],
    { offset: 68, text: tail },
  )

test('a completed block is given the same text while the tail grows, even as the tail streams definitions', () => {
  const [firstEarlier, secondEarlier] = blocksWhileTailIs('[docs]: https://docs.exa')
  const [firstLater, secondLater] = blocksWhileTailIs('[docs]: https://docs.example.com/guide\n[1]: https://exa')
  expect(firstLater).toEqual(firstEarlier)
  expect(secondLater).toEqual(secondEarlier)
  expect(firstLater?.text).toBe('[chart]: <out/chart.png>\n\nSee [the docs][docs] and ![Chart][chart].')
  expect(firstLater?.shownImages).toBe(1)
})

test('the tail sees the definitions of the completed blocks along with its own', () => {
  const tail = blocksWhileTailIs('![Again][chart] and ![Map][map]\n\n[map]: out/map.png').at(-1)
  expect(tail?.text.startsWith('[chart]: <out/chart.png>\n\n')).toBe(true)
  expect(tail?.shownImages).toBe(2)
})

test('a definition written inside a quote or a list item over several lines is shared as a plain definition, never as stray text', () => {
  const sharedBlocks = withDefinitionsShared(
    [
      { text: '> See [quoted].\n>\n> [quoted]:\n> https://example.com/a>b "A \\"quoted\\" title"' },
      { text: '- [listed]:\n  https://example.com/list' },
    ],
    { text: 'Read [quoted] and [listed].' },
  )
  const tail = sharedBlocks.at(-1)
  const parsed = fromMarkdown(tail?.text ?? '')
  expect(parsed.children.map(({ type }) => type)).toEqual(['definition', 'definition', 'paragraph'])
  expect(parsed.children.slice(0, 2)).toMatchObject([
    { type: 'definition', identifier: 'quoted', url: 'https://example.com/a>b', title: 'A "quoted" title' },
    { type: 'definition', identifier: 'listed', url: 'https://example.com/list', title: null },
  ])
})

test('a shared definition keeps escapes and entities of its label, address and title, so its references still resolve', () => {
  const tail = withDefinitionsShared(
    [{ text: '[a\\]b]: /x\n[x&amp;y]: /y\n[p\\\\q]: /z\n[Ab  C]: /a&amp;copy;b "t &amp; \\" q"' }],
    { text: '[a\\]b] [x&amp;y] [p\\\\q] [ab c]' },
  ).at(-1)
  const parsed = fromMarkdown(tail?.text ?? '')
  expect(parsed.children.map(({ type }) => type)).toEqual([
    'definition',
    'definition',
    'definition',
    'definition',
    'paragraph',
  ])
  expect(parsed.children.slice(0, 4)).toMatchObject([
    { identifier: 'a\\]b', url: '/x' },
    { identifier: 'x&amp;y', url: '/y' },
    { identifier: 'p\\\\q', url: '/z' },
    { identifier: 'ab c', url: '/a&copy;b', title: 't & " q' },
  ])
})
