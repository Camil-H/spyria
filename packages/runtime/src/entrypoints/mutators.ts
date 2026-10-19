import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { type ChatId, type MemberId, runtimeHostId, type WorkspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { NotCurrentWorkspace } from '../domain/errors.ts'
import { contextPermissionsOf, createZeroTransactor } from '../integrations/zero-transactor.ts'
import { removeChatRuntime } from '../operations/remove-chat-runtime.ts'
import { removeMemberMachine } from '../operations/remove-member-machine.ts'
import { removeRuntimeHost } from '../operations/remove-runtime-host.ts'
import { setLocalSessions } from '../operations/set-local-sessions.ts'
import { stopChatRuntime } from '../operations/stop-chat-runtime.ts'

const workspaceArguments = z.object({ workspaceId: z.string().check(z.minLength(1)) })
const hostArguments = z.extend(workspaceArguments, {
  hostId: z.pipe(z.string().check(z.minLength(1)), z.transform(runtimeHostId)),
})

export const runtimeMutators = defineMutators({
  runtime: {
    removeHost: defineMutator(hostArguments, async ({ tx, ctx, args }) => {
      if (args.workspaceId !== ctx.workspaceId) throw new NotCurrentWorkspace()
      await removeRuntimeHost(
        { transactor: createZeroTransactor(tx) },
        {
          workspaceId: ctx.workspaceId,
          memberId: ctx.userId,
          permissions: await contextPermissionsOf(tx, ctx),
          hostId: args.hostId,
          now: Date.now(),
        },
      )
    }),
    setLocalSessions: defineMutator(z.extend(workspaceArguments, { isOn: z.boolean() }), async ({ tx, ctx, args }) => {
      if (args.workspaceId !== ctx.workspaceId) throw new NotCurrentWorkspace()
      await setLocalSessions(
        { transactor: createZeroTransactor(tx) },
        { workspaceId: ctx.workspaceId, permissions: await contextPermissionsOf(tx, ctx), isOn: args.isOn },
      )
    }),
  },
})

export const removeChatRuntimeOnServer = async (tx: Transaction, workspaceId: WorkspaceId, chatId: ChatId) => {
  if (tx.location === 'server')
    await removeChatRuntime({ transactor: createZeroTransactor(tx) }, { workspaceId, chatId, now: Date.now() })
}

export const stopChatRuntimeOnServer = async (tx: Transaction, workspaceId: WorkspaceId, chatId: ChatId) => {
  if (tx.location === 'server')
    await stopChatRuntime({ transactor: createZeroTransactor(tx) }, { workspaceId, chatId, now: Date.now() })
}

export const removeMemberMachineOnServer = async (tx: Transaction, workspaceId: WorkspaceId, memberId: MemberId) =>
  tx.location === 'server'
    ? removeMemberMachine({ transactor: createZeroTransactor(tx) }, { workspaceId, memberId, now: Date.now() })
    : undefined
