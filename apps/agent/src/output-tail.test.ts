import { expect, test } from 'bun:test'
import { outputTailOf } from './output-tail.ts'

const token = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

test('an output within the limit is kept whole', () => {
  expect(outputTailOf(`key ${token}\nok\n`, 1_000)).toBe(`key ${token}\nok\n`)
})

test('a tail starts after a whitespace, so it never begins inside a token the host would no longer recognise', () => {
  const output = `${token}\nrunning tests\n`
  for (let maximumCharacters = 1; maximumCharacters < output.length; maximumCharacters++) {
    const tail = outputTailOf(output, maximumCharacters)
    expect(output.endsWith(tail)).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(maximumCharacters)
    expect(tail.includes(token.slice(-4)) ? tail.includes(token) : true).toBe(true)
  }
  expect(outputTailOf(output, output.length - 1)).toBe('running tests\n')
})

test('a tail with no whitespace in it is dropped', () => {
  expect(outputTailOf(`start ${token}`, 20)).toBe('')
})
