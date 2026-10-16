import { expect, test } from 'bun:test'
import { capacityOf } from './runtime-host.ts'

const gibibyte = 1024 ** 3
const system = {
  cpus: 8,
  memoryBytes: 8 * gibibyte,
  dockerVersion: '29.0.0',
  rootless: true,
  cgroupDriver: 'systemd',
  limitsEnforced: true,
}

test('the default cap is one runtime per GB after a 2 GB reserve, at least one', () => {
  expect(capacityOf(system).cap).toBe(6)
  expect(capacityOf({ ...system, memoryBytes: 16 * gibibyte }).cap).toBe(14)
  expect(capacityOf({ ...system, memoryBytes: 2.5 * gibibyte }).cap).toBe(1)
  expect(capacityOf({ ...system, memoryBytes: gibibyte }).cap).toBe(1)
  expect(capacityOf(system)).toEqual({ ...system, cap: 6 })
})
