import { expect, test } from 'bun:test'
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
  expect(firstLater?.text).toBe('[chart]: out/chart.png\n\nSee [the docs][docs] and ![Chart][chart].')
  expect(firstLater?.shownImages).toBe(1)
})

test('the tail sees the definitions of the completed blocks along with its own', () => {
  const tail = blocksWhileTailIs('![Again][chart] and ![Map][map]\n\n[map]: out/map.png').at(-1)
  expect(tail?.text.startsWith('[chart]: out/chart.png\n\n')).toBe(true)
  expect(tail?.shownImages).toBe(2)
})
