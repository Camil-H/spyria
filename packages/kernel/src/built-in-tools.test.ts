import { expect, test } from 'bun:test'
import { githubToolApprovalOf, githubToolsOf, isReadOnlyGitHubTool } from './built-in-tools.ts'
import { memberId } from './ids.ts'
import type { ToolServerAccess } from './tool-access.ts'

const bob = memberId('bob')
const bobAsMember = { memberId: bob, roleId: 'member' }
const githubAccessOf = (access: Partial<ToolServerAccess>): ToolServerAccess => ({
  connectionId: 'github',
  roleId: 'member',
  level: 'read',
  toolChanges: {},
  ...access,
})
const writeTools = ['push_branch', 'open_pull_request', 'update_pull_request']
const readTools = ['fetch_branch', 'read_review_threads', 'read_checks', 'list_issues', 'read_issue']

test('a role without a GitHub setting reads and writes, so dev chats work before an admin sets levels', () => {
  expect(githubToolsOf([], bobAsMember)).toEqual([...writeTools, ...readTools])
  expect(githubToolsOf([githubAccessOf({ connectionId: 'crm', level: 'none' })], bobAsMember)).toHaveLength(8)
})

test("a role's GitHub level and single tools narrow it, for that role only", () => {
  expect(githubToolsOf([githubAccessOf({ level: 'read' })], bobAsMember)).toEqual(readTools)
  expect(githubToolsOf([githubAccessOf({ level: 'none' })], bobAsMember)).toEqual([])
  expect(githubToolsOf([githubAccessOf({ level: 'read', toolChanges: { push_branch: true } })], bobAsMember)).toEqual([
    'push_branch',
    ...readTools,
  ])
  const rows = [githubAccessOf({ level: 'none' }), githubAccessOf({ roleId: 'admin', level: 'write' })]
  expect(githubToolsOf(rows, bobAsMember)).toEqual([])
  expect(githubToolsOf(rows, { memberId: memberId('lee'), roleId: 'admin' })).toHaveLength(8)
})

test("GitHub's read tools are the ones that change nothing on GitHub, and no call waits until its member asks", () => {
  expect(readTools.every(isReadOnlyGitHubTool)).toBe(true)
  expect(writeTools.some(isReadOnlyGitHubTool)).toBe(false)
  expect(githubToolApprovalOf('push_branch')).toBe('never')
  const preference = {
    connectionId: 'github',
    serverApproval: 'always' as const,
    toolApprovals: { read_issue: 'always' as const },
  }
  expect(githubToolApprovalOf('push_branch', preference)).toBe('always')
  expect(githubToolApprovalOf('read_checks', preference)).toBe('never')
  expect(githubToolApprovalOf('read_issue', preference)).toBe('always')
  expect(githubToolApprovalOf('unknown', preference)).toBeUndefined()
})
