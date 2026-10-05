import {
  type ConversationCommands,
  conversationMutators,
  createStoreDraftRepository,
  saveDraft,
} from '@hq/conversation/server'
import { createZeroStore, type Store, type WorkspaceSession } from '@hq/db/zero-store'
import { type MemberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import { createHttpLlmCredentialAdder, type ProfileCommands, profileMutators } from '@hq/profile/server'
import type { Session } from '@hq/session'
import { type WorkspaceCommands, workspaceMutators } from '@hq/workspace/server'
import { logOut, openSession, renew, signInWithPopup } from './auth.ts'

const zeroCacheURL = import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848'
const testStack = import.meta.env.DEV
  ? (window as Window & { hqTestStack?: { zeroCacheURL: string } }).hqTestStack
  : undefined

type CommandInput = { workspaceId: WorkspaceId; [argument: string]: unknown }
type Mutator = (args: never) => Parameters<Store['mutate']>[1]

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationCommands: ConversationCommands
  profileCommands: ProfileCommands
}

export const createApp = async (
  memberId: MemberId,
  defaultWorkspaceId: WorkspaceId,
  sessions: readonly WorkspaceSession[],
): Promise<Application> => {
  const store = createZeroStore({
    memberId,
    sessions,
    renew,
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators, ...profileMutators },
    draftStorage: localStorage,
  })
  await store.whenLoaded(defaultWorkspaceId)
  const mutate = async (mutator: Mutator, input: CommandInput) => {
    const id = crypto.randomUUID()
    const { confirmation } = await store.mutate(input.workspaceId, mutator({ ...input, id } as never))
    return { id, confirmation }
  }
  const commandsOf = <Commands>(mutators: Record<string, Mutator>, overrides: Partial<Commands>) =>
    ({
      ...Object.fromEntries(
        Object.entries(mutators).map(([name, mutator]) => [
          name,
          async (input: CommandInput) => (await mutate(mutator, input)).id,
        ]),
      ),
      ...overrides,
    }) as Commands
  const drafts = createStoreDraftRepository(store)
  return {
    store,
    session: {
      memberId,
      defaultWorkspaceId,
      signedInWorkspaceIds: store.signedInWorkspaceIds,
      subscribe: store.subscribe,
      signOut: async (workspaceId) => {
        await logOut(workspaceId).catch(console.error)
        await store.signOut(workspaceId)
      },
      signIn: async (workspaceId) => {
        if ((await signInWithPopup(workspaceId)).status !== 'signed_in') return
        const session = await renew(workspaceId)
        if (session) await store.signIn(session)
      },
    },
    workspaceCommands: commandsOf<WorkspaceCommands>(workspaceMutators.workspace, {
      createWorkspace: async (input) => {
        const bearerToken = store.tokenOf(input.workspaceId)
        const { id, confirmation } = await mutate(workspaceMutators.workspace.createWorkspace, input)
        store.signInToNew(
          workspaceId(id),
          confirmation.then(() => openSession(workspaceId(id), bearerToken)),
        )
        return id
      },
    }),
    conversationCommands: commandsOf<ConversationCommands>(conversationMutators.conversation, {
      saveDraft: (input) => saveDraft({ drafts }, { ...input, memberId }),
      startRuntimeFromMessage: async (input) => {
        const newChatId = crypto.randomUUID()
        await mutate(conversationMutators.conversation.startRuntimeFromMessage, { ...input, chatId: newChatId })
        return newChatId
      },
    }),
    profileCommands: commandsOf<ProfileCommands>(profileMutators.profile, {
      addLlmCredential: createHttpLlmCredentialAdder((workspaceId, path, body) =>
        fetch(path, {
          method: 'POST',
          headers: { authorization: `Bearer ${store.tokenOf(workspaceId)}`, 'content-type': 'application/json' },
          body,
        }),
      ),
    }),
  }
}
