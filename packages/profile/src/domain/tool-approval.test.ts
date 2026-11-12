import { expect, test } from 'bun:test'
import { workspaceId } from '@spyria/kernel'
import { preferenceWith } from './tool-approval.ts'
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
  codeMode: false,
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
