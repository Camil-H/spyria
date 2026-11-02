import { expect, test } from 'bun:test'
import { isAgentOutOfDate, minimumAgentProtocol, readinessOf } from './agent-version.ts'

test('a ready answer yields the agent version and protocol; a bare, malformed or legacy answer counts as protocol 0 without a version', () => {
  expect(readinessOf('{"status":"ready","agentVersion":"1.2.0","protocolVersion":3}')).toEqual({
    agentVersion: '1.2.0',
    protocolVersion: 3,
  })
  expect(readinessOf('{"status":"ready"}')).toEqual({ agentVersion: null, protocolVersion: 0 })
  expect(readinessOf('')).toEqual({ agentVersion: null, protocolVersion: 0 })
  expect(readinessOf('{"protocolVersion":"3","agentVersion":7}')).toEqual({ agentVersion: null, protocolVersion: 0 })
})

test('an agent below the minimum protocol is out of date', () => {
  expect(isAgentOutOfDate({ agentVersion: null, protocolVersion: 0 })).toBe(true)
  expect(isAgentOutOfDate({ agentVersion: '1.0.0', protocolVersion: minimumAgentProtocol })).toBe(false)
})
