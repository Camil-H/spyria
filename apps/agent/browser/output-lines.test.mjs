import { expect, test } from 'bun:test'
import { createLineSender } from './output-lines.mjs'

const senderWriting = (options = {}) => {
  const written = []
  const sender = createLineSender({ write: (line) => written.push(JSON.parse(line)), partSize: 10, ...options })
  return { written, sender }
}
const joined = (parts) => JSON.parse(parts.map(({ data }) => data).join(''))

test('a small line goes out whole, at once', () => {
  const { written, sender } = senderWriting({ partSize: 100 })
  sender.send({ type: 'page', url: 'https://example.com/' })
  expect(written).toEqual([{ type: 'page', url: 'https://example.com/' }])
})

test('a large line goes out in parts, each only once the one before is acknowledged, so one part at most waits on the host', () => {
  const { written, sender } = senderWriting()
  const download = { type: 'download', name: 'report.pdf', data: 'x'.repeat(40) }
  sender.send(download)
  expect(written).toHaveLength(1)
  expect(written[0]).toMatchObject({ type: 'part', isLast: false })
  while (written.at(-1).isLast === false) sender.acknowledgePart()
  expect(joined(written)).toEqual(download)
})

test('large lines queue behind each other, while small ones never wait', () => {
  const { written, sender } = senderWriting({ partSize: 30 })
  const first = { id: 1, result: { text: 'Screenshot', image: 'a'.repeat(40) } }
  const second = { type: 'download', name: 'b', data: 'b'.repeat(40) }
  sender.send(first)
  sender.send(second)
  sender.send({ type: 'frame' })
  expect(written.map(({ type }) => type)).toEqual(['part', 'frame'])
  const partsOf = () => written.filter(({ type }) => type === 'part')
  while (partsOf().filter(({ isLast }) => isLast).length < 2) sender.acknowledgePart()
  const parts = partsOf()
  const lastOfFirst = parts.findIndex(({ isLast }) => isLast)
  expect(joined(parts.slice(0, lastOfFirst + 1))).toEqual(first)
  expect(joined(parts.slice(lastOfFirst + 1))).toEqual(second)
})

test('a line over the limit in bytes, multi-byte characters included, becomes a refusal for its command or a notice', () => {
  const { written, sender } = senderWriting({ maximumBytes: 100, partSize: 1000 })
  sender.send({ id: 7, result: '漢'.repeat(40) })
  sender.send({ type: 'page', title: '漢'.repeat(40) })
  expect(written).toEqual([
    { id: 7, error: 'The answer is too large to send' },
    { type: 'notice', text: 'The answer is too large to send' },
  ])
})
