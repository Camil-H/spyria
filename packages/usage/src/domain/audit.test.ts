import { expect, test } from 'bun:test'
import { memberId } from '@spyria/kernel'
import {
  auditCsvHeader,
  auditCsvLinesOf,
  auditEntryOf,
  auditFilterFrom,
  auditKindsOf,
  keptSince,
  retentionDaysFrom,
} from './audit.ts'

const record = {
  key: 't:call-1',
  at: '2026-10-18T10:00:00.123456Z',
  kind: 'tool.called',
  actorId: 'member-bob',
  actorName: 'Bob',
  target: 'crm · update',
  details: { server: 'crm', readOnly: false, decision: 'approved', decidedBy: 'Alice', allowedTools: [] },
}

test('a record reads in plain words with labelled details, and a missing actor is the System', () => {
  expect(auditEntryOf(record)).toEqual({
    key: 't:call-1',
    at: '2026-10-18T10:00:00.123456Z',
    actorId: 'member-bob',
    person: 'Bob',
    action: 'Called a tool',
    target: 'crm · update',
    details: [
      { label: 'Server', value: 'crm' },
      { label: 'Read only', value: 'No' },
      { label: 'Decision', value: 'approved' },
      { label: 'Decided by', value: 'Alice' },
      { label: 'Allowed tools', value: 'None' },
    ],
  })
  expect(auditEntryOf({ ...record, actorId: null, actorName: null }).person).toBe('System')
  expect(
    auditEntryOf({ ...record, kind: 'audit.retention_changed', target: null, details: { retentionDays: 30 } }),
  ).toMatchObject({ action: 'Changed how long audit records are kept', target: '30 days' })
  expect(auditEntryOf({ ...record, kind: 'audit.retention_changed', target: null, details: {} }).target).toBe('Forever')
})

test('a deleted message reads as such with its chat and its text, and pages on from its key', () => {
  expect(
    auditEntryOf({
      ...record,
      key: 'd:message-1',
      kind: 'message.deleted',
      target: 'Welcome',
      details: { chat: 'Welcome', text: 'The staging password is hunter2' },
    }),
  ).toMatchObject({
    action: 'Deleted a message',
    target: 'Welcome',
    details: [
      { label: 'Chat', value: 'Welcome' },
      { label: 'Text', value: 'The staging password is hunter2' },
    ],
  })
  expect(auditFilterFrom({ cursor: '2026-10-18T10:00:00.123456Z~d:message-1' }).cursor).toEqual({
    at: '2026-10-18T10:00:00.123456Z',
    key: 'd:message-1',
  })
  expect(auditKindsOf('Chats')).toContain('message.deleted')
})

test('filters are read from the query and refused when malformed', () => {
  expect(
    auditFilterFrom({
      person: 'member-alice',
      group: 'Members',
      from: '2026-10-01T00:00:00.000Z',
      cursor: '2026-10-18T10:00:00.123456Z~w:event-1',
    }),
  ).toEqual({
    personId: memberId('member-alice'),
    group: 'Members',
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: null,
    cursor: { at: '2026-10-18T10:00:00.123456Z', key: 'w:event-1' },
  })
  expect(auditFilterFrom({})).toEqual({ personId: null, group: null, from: null, to: null, cursor: null })
  for (const query of [{ group: 'Everything' }, { from: 'yesterday' }, { cursor: 'w:event-1' }])
    expect(() => auditFilterFrom(query)).toThrow('The audit log filter is not valid')
  expect(auditKindsOf('Tool calls')).toEqual(['tool.called'])
  expect(auditKindsOf(null)).toBeNull()
})

test('the retention window narrows the date range and only whole days from 1 to 36500 are kept', () => {
  const now = new Date('2026-10-18T00:00:00Z')
  expect(keptSince(null, null, now)).toBeNull()
  expect(keptSince(null, 30, now)).toEqual(new Date('2026-09-18T00:00:00Z'))
  expect(keptSince(new Date('2026-10-01T00:00:00Z'), 30, now)).toEqual(new Date('2026-10-01T00:00:00Z'))
  expect(keptSince(new Date('2026-01-01T00:00:00Z'), 30, now)).toEqual(new Date('2026-09-18T00:00:00Z'))
  expect(retentionDaysFrom(null)).toBeNull()
  expect(retentionDaysFrom(30)).toBe(30)
  for (const value of [0, 36_501, 1.5, '30', undefined])
    expect(() => retentionDaysFrom(value)).toThrow('Keep audit records forever or for 1 to 36500 days')
})

test('CSV lines quote separators and neutralize spreadsheet formulas', () => {
  const entry = auditEntryOf({ ...record, target: '=HYPERLINK("x")', details: { title: 'Fix, "quoted"' } })
  expect(auditCsvHeader).toBe('Time,Person,Action,Target,Details\n')
  expect(auditCsvLinesOf([entry])).toBe(
    `2026-10-18T10:00:00.123456Z,Bob,Called a tool,"'=HYPERLINK(""x"")","Title: Fix, ""quoted"""\n`,
  )
})
