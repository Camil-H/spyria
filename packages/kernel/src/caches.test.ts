import { expect, test } from 'bun:test'
import { createBoundedCache, createSingleflight } from './caches.ts'

test('a bounded cache evicts the least recently used entry beyond its capacity', () => {
  const cache = createBoundedCache<string, number>(2)
  cache.set('first', 1)
  cache.set('second', 2)
  expect(cache.get('first')).toBe(1)
  cache.set('third', 3)
  expect([cache.get('first'), cache.get('second'), cache.get('third'), cache.size]).toEqual([1, undefined, 3, 2])
})

test('a singleflight runs one call per key at a time, shares its outcome, and forgets it once settled', async () => {
  const singleflight = createSingleflight<number>()
  let calls = 0
  const slowCall = () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5))
  expect(await Promise.all([singleflight('key', slowCall), singleflight('key', slowCall)])).toEqual([1, 1])
  expect(await singleflight('key', slowCall)).toBe(2)
  const failing = () => Promise.reject(new Error('down'))
  const outcomes = await Promise.allSettled([singleflight('key', failing), singleflight('key', failing)])
  expect(outcomes.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
  expect(await singleflight('key', slowCall)).toBe(3)
})
