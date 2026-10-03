import { type MemberRow, ownedBy, type Store } from '@hq/db'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { DisplayName } from '../domain/display-name.ts'
import { MemberNotFound } from '../domain/errors.ts'
import type { Member } from '../domain/member.ts'

const toMember = (row: MemberRow): Member => ({ ...row, name: DisplayName(row.name) })

export const createStoreTransactor = (store: Store): ProfileTransactor => ({
  run: async (work) => {
    const initial = store.read()
    let { members, llmCredentials, toolConnections } = initial
    const unitOfWork: UnitOfWork = {
      members: {
        get: async (workspaceId, memberId) => {
          const row = members.find((candidate) => candidate.id === memberId)
          const isMember = initial.memberships.some(
            (membership) => membership.workspaceId === workspaceId && membership.memberId === memberId,
          )
          if (!row || !isMember) throw new MemberNotFound(memberId)
          return toMember(row)
        },
        save: async (member) => {
          members = members.map((row) => (row.id === member.id ? member : row))
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
        },
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
      members !== initial.members ||
      llmCredentials !== initial.llmCredentials ||
      toolConnections !== initial.toolConnections
    )
      store.write((current) => ({ ...current, members, llmCredentials, toolConnections }))
    return result
  },
})
