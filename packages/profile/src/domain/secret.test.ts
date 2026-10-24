import { expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { BlankSecret } from './errors.ts'
import { Secret } from './secret.ts'

test('Secret redacts itself in text, JSON and inspection', () => {
  const secret = new Secret('sk-test-1234567890')
  expect(String(secret)).not.toContain('1234')
  expect(`${secret}`).not.toContain('1234')
  expect(JSON.stringify({ secret })).not.toContain('1234')
  expect(inspect(secret)).not.toContain('1234')
  expect(inspect({ nested: [secret] })).not.toContain('1234')
})

test('last4 derives the last four characters and Secret rejects blank values', () => {
  expect(new Secret('sk-test-1234567890').last4()).toBe('7890')
  expect(new Secret('sk-test-1234567890').reveal()).toBe('sk-test-1234567890')
  expect(() => new Secret('   ')).toThrow(BlankSecret)
})

test('last4 never shows more than half of a short secret', () => {
  expect(new Secret('abcdefgh').last4()).toBe('efgh')
  expect(new Secret('abcdefg').last4()).toBe('efg')
  expect(new Secret('abcd  ').last4()).toBe('cd')
  expect(new Secret('abc').last4()).toBe('c')
  expect(new Secret('a').last4()).toBe('')
})
