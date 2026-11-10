import { expect, test } from 'bun:test'
import { createWorkspaceReadings } from './workspace-readings.ts'

test('a kept reading outlives the tab that read it, a refresh counts per reading and tells the listeners', () => {
  const readings = createWorkspaceReadings()
  let notified = 0
  const unsubscribe = readings.subscribe(() => {
    notified += 1
  })
  readings.keep('changes', { version: 'a|0', value: { isLive: true, files: '' } })
  readings.refresh('changes')
  expect(readings.keptOf('changes')).toEqual({ version: 'a|0', value: { isLive: true, files: '' } })
  expect([readings.refreshCountOf('changes'), readings.refreshCountOf('commits')]).toEqual([1, 0])
  unsubscribe()
  readings.refresh('changes')
  expect(notified).toBe(2)
})

test('only the 30 readings kept last stay once nothing shows them, and a shown one is never dropped', () => {
  const readings = createWorkspaceReadings()
  const unwatchRoot = readings.watch('tree-root')
  readings.keep('tree-root', { version: '', value: { isLive: true } })
  for (let index = 0; index < 31; index++) readings.keep(`file-${index}`, { version: '', value: { isLive: true } })
  readings.keep('file-1', { version: 'again', value: { isLive: true } })
  readings.keep('file-31', { version: '', value: { isLive: true } })
  expect(readings.keptOf('tree-root')).toBeDefined()
  expect(readings.keptOf('file-0')).toBeUndefined()
  expect(readings.keptOf('file-2')).toBeUndefined()
  expect(readings.keptOf('file-1')?.version).toBe('again')
  expect(readings.keptOf('file-31')).toBeDefined()
  unwatchRoot()
  expect(readings.keptOf('tree-root')).toBeUndefined()
})
