import { expect, test } from 'bun:test'
import { outputTailOf } from './output-tail.ts'

const token = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const jwt = 'eyJ-fake-header.eyJ-fake-payload.fake-signature'

test('an output within the limit is kept whole', () => {
  expect(outputTailOf(`key ${token}\nok\n`, 1_000)).toBe(`key ${token}\nok\n`)
})

test.each([token, jwt])('a tail never begins inside a token the host would no longer recognise: %s', (secret) => {
  const output = `{"token":"${secret}","items":[1,2,3]}\nrunning tests\n`
  for (let maximumCharacters = 1; maximumCharacters < output.length; maximumCharacters++) {
    const tail = outputTailOf(output, maximumCharacters)
    expect(output.endsWith(tail)).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(maximumCharacters)
    expect(tail.includes(secret.slice(-4)) ? tail.includes(secret) : true).toBe(true)
  }
})

test('a long output without whitespace keeps its tail from the first character a token cannot hold', () => {
  const compactJson = `[${Array.from({ length: 2_000 }, (_, index) => `{"id":${index}}`).join(',')}]`
  const tail = outputTailOf(compactJson, 4_000)
  expect(tail.length).toBeGreaterThan(3_990)
  expect(compactJson.endsWith(tail)).toBe(true)
  expect(tail).toMatch(/^[^\w.-]/)
})
