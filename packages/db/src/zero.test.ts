import { expect, test } from 'bun:test'
import { schema } from './zero.ts'

test('the Zero schema sent to clients carries no secret column and no gateway key table', () => {
  const tables = Object.values(schema.tables).map((table) => ({
    name: 'serverName' in table ? table.serverName : table.name,
    columns: Object.entries(table.columns).map(([name, column]) => ('serverName' in column ? column.serverName : name)),
  }))
  const columns = tables.flatMap((table) => table.columns)
  expect(tables.map((table) => table.name)).not.toContain('member_gateway_keys')
  for (const secret of [
    'api_key',
    'token_hash',
    'claim_code_hash',
    'secret_ref',
    'llm_token_hash',
    'llm_switch_token_hash',
  ])
    expect(columns).not.toContain(secret)
  expect(columns.filter((column) => /secret|_hash$|api_key|token$/.test(column))).toEqual([])
  expect(columns.filter((column) => column.startsWith('agent_turn_'))).toEqual(['agent_turn_message_id'])
})
