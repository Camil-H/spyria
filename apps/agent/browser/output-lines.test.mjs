import { expect, test } from 'bun:test'
import { createLineWriter } from './output-lines.mjs'

const writing = (maximumBytes) => {
  const written = []
  return { written, send: createLineWriter({ write: (line) => written.push(JSON.parse(line)), maximumBytes }) }
}

test('a line goes out whole', () => {
  const { written, send } = writing(100)
  send({ type: 'page', url: 'https://example.com/' })
  expect(written).toEqual([{ type: 'page', url: 'https://example.com/' }])
})

test('a line over the limit in bytes, multi-byte characters included, becomes a refusal for its command or a notice', () => {
  const { written, send } = writing(100)
  send({ id: 7, result: '漢'.repeat(40) })
  send({ type: 'page', title: '漢'.repeat(40) })
  expect(written).toEqual([
    { id: 7, error: 'The answer is too large to send' },
    { type: 'notice', text: 'The answer is too large to send' },
  ])
})
