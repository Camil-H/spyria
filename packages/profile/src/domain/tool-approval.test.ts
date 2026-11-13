import { expect, test } from 'bun:test'
import { type ConnectionTool, type ToolApproval, workspaceId } from '@spyria/kernel'
import { approvalChangesOf, preferenceWith, toolKindOf } from './tool-approval.ts'
import type { WorkspaceConnection } from './workspace-connection.ts'

const docs: WorkspaceConnection = {
  workspaceId: workspaceId('workspace-acme'),
  id: 'connection-docs',
  name: 'Docs',
  gatewayName: 'docs_1a2b3c',
  url: 'https://docs.example/mcp',
  signIn: 'member',
  setupId: null,
  headerName: null,
  tools: [{ name: 'publish', readOnly: false, destructive: false }],
  isReviewed: true,
}

test("a member sets the server's default and a tool's own approval, and clears a tool's back to the default", () => {
  const always = preferenceWith(docs, undefined, { tool: null, approval: 'always' })
  expect(always).toEqual({ connectionId: docs.id, serverApproval: 'always', toolApprovals: {} })
  const publishNever = preferenceWith(docs, always, { tool: 'publish', approval: 'never' })
  expect(publishNever.toolApprovals).toEqual({ publish: 'never' })
  expect(preferenceWith(docs, publishNever, { tool: 'publish', approval: null }).toolApprovals).toEqual({})
})

test("only shared-login servers take approval on a guest's prompt, and only for tools they list", () => {
  expect(() => preferenceWith(docs, undefined, { tool: null, approval: 'guest' })).toThrow('takes no such approval')
  expect(preferenceWith({ ...docs, signIn: 'shared' }, undefined, { tool: null, approval: 'guest' })).toMatchObject({
    serverApproval: 'guest',
  })
  expect(() => preferenceWith(docs, undefined, { tool: 'drop', approval: 'never' })).toThrow('Docs has no tool drop')
})
const toolOf = (name: string, kind: Partial<ConnectionTool> = {}): ConnectionTool => ({
  name,
  readOnly: false,
  destructive: false,
  ...kind,
})
const lookup = toolOf('lookup', { readOnly: true })
const search = toolOf('search', { readOnly: true })
const purge = toolOf('purge', { destructive: true })

test('sorts each tool into Read, Write or Destructive, a destructive one first even when it only reads', () => {
  expect(toolKindOf(lookup)).toBe('Read')
  expect(toolKindOf(toolOf('update'))).toBe('Write')
  expect(toolKindOf(purge)).toBe('Destructive')
  expect(toolKindOf(toolOf('wipe', { readOnly: true, destructive: true }))).toBe('Destructive')
})

test('sets every tool to a choice that is not their default, leaving out those already on it', () => {
  const own: Record<string, ToolApproval> = { search: 'always' }
  expect(
    approvalChangesOf([lookup, search], 'always', {
      ownApprovalOf: (tool) => own[tool.name] ?? null,
      defaultApprovalOf: () => 'never',
    }),
  ).toEqual([{ tool: 'lookup', approval: 'always' }])
})

test('clears the tools’ own choices when the choice is their default, and changes nothing already on it', () => {
  const own: Record<string, ToolApproval> = { lookup: 'always' }
  expect(
    approvalChangesOf([lookup, search], 'never', {
      ownApprovalOf: (tool) => own[tool.name] ?? null,
      defaultApprovalOf: () => 'never',
    }),
  ).toEqual([{ tool: 'lookup', approval: null }])
})
