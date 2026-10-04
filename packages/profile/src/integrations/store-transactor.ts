import { ownedBy, type Store } from '@hq/db'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { DisplayName } from '../domain/display-name.ts'
import { MemberNotFound } from '../domain/errors.ts'
import { secretRef } from '../domain/llm-credential.ts'

export const createStoreTransactor = (store: Store): ProfileTransactor => ({
  run: async (work) => {
    const initial = store.read()
    let { memberships, llmCredentials, toolConnections } = initial
    const unitOfWork: UnitOfWork = {
      members: {
        get: async (workspaceId, memberId) => {
          const row = memberships.find(ownedBy(workspaceId, memberId))
          if (!row) throw new MemberNotFound(memberId)
          return { workspaceId, id: memberId, name: DisplayName(row.displayName) }
        },
        save: async (member) => {
          memberships = memberships.map((row) =>
            ownedBy(member.workspaceId, member.id)(row) ? { ...row, displayName: member.name } : row,
          )
        },
      },
      llmCredentials: {
        add: async (credential) => {
          llmCredentials = [...llmCredentials, credential]
        },
        remove: async (workspaceId, memberId, credentialId) => {
          llmCredentials = llmCredentials.filter(
            (row) => !(row.id === credentialId && ownedBy(workspaceId, memberId)(row)),
          )
          return null
        },
      },
      secrets: {
        keep: async () => secretRef('discarded-in-memory'),
        discard: async () => {},
      },
      personalConnections: {
        list: async (workspaceId, memberId) => toolConnections.filter(ownedBy(workspaceId, memberId)),
        replace: async (workspaceId, memberId, connections) => {
          toolConnections = [...toolConnections.filter((row) => !ownedBy(workspaceId, memberId)(row)), ...connections]
        },
        toolCatalog: async () => initial.toolCatalog,
      },
    }
    const result = await work(unitOfWork)
    if (
      memberships !== initial.memberships ||
      llmCredentials !== initial.llmCredentials ||
      toolConnections !== initial.toolConnections
    )
      store.write((current) => ({ ...current, memberships, llmCredentials, toolConnections }))
    return result
  },
})
