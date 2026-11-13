import { expect, test } from 'bun:test'
import { streamedBlocksOf } from './streamed-markdown.ts'

const textsOf = (text: string) => {
  const { completed, tail } = streamedBlocksOf(text)
  return { completed: completed.map((block) => block.text), tail: tail.text }
}

test('blocks before a blank line are complete once the next block has started, and the rest is the tail', () => {
  expect(textsOf('# Plan\n\nFirst step\nstill first\n\nSecond')).toEqual({
    completed: ['# Plan', 'First step\nstill first'],
    tail: 'Second',
  })
  expect(textsOf('# Plan\n\n')).toEqual({ completed: [], tail: '# Plan\n\n' })
  expect(streamedBlocksOf('# Plan\n\nSecond').tail).toEqual({ offset: 8, text: 'Second' })
})

test('a blank line inside a fenced block or before an indented continuation does not end the block', () => {
  const fenced = 'Run:\n\n```sh\nbun install\n\nbun test\n```\n\nDone'
  expect(textsOf(fenced)).toEqual({ completed: ['Run:', '```sh\nbun install\n\nbun test\n```'], tail: 'Done' })
  expect(textsOf('Run:\n\n~~~\nopen\n\nstill open')).toEqual({ completed: ['Run:'], tail: '~~~\nopen\n\nstill open' })
  expect(textsOf('- item\n\n    indented code\n\nNext')).toEqual({
    completed: ['- item\n\n    indented code'],
    tail: 'Next',
  })
})

test('the completed blocks of a growing text never change, so only the tail is parsed again', () => {
  const text = '# Plan\n\n1. Read\n2. Edit\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nThat is all.'
  const blocksAt = (length: number) => streamedBlocksOf(text.slice(0, length)).completed
  for (let length = 1; length < text.length; length++)
    expect(blocksAt(text.length).slice(0, blocksAt(length).length)).toEqual(blocksAt(length))
  const { completed, tail } = streamedBlocksOf(text)
  expect([...completed, tail].map((block) => text.slice(block.offset, block.offset + block.text.length))).toEqual(
    [...completed, tail].map((block) => block.text),
  )
  expect([...completed, tail].map((block) => block.text).join('\n\n')).toBe(text)
})
