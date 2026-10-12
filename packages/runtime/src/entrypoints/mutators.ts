import { runtimeHostId } from '@hq/kernel'
import { defineMutator, defineMutators } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { NotCurrentWorkspace } from '../domain/errors.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { removeRuntimeHost } from '../operations/remove-runtime-host.ts'
import { setLocalSessions } from '../operations/set-local-sessions.ts'

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
        { workspaceId: ctx.workspaceId, memberId: ctx.userId, role: ctx.role, hostId: args.hostId, now: Date.now() },
      )
    }),
    setLocalSessions: defineMutator(z.extend(workspaceArguments, { isOn: z.boolean() }), async ({ tx, ctx, args }) => {
      if (args.workspaceId !== ctx.workspaceId) throw new NotCurrentWorkspace()
      await setLocalSessions(
        { transactor: createZeroTransactor(tx) },
        { workspaceId: ctx.workspaceId, role: ctx.role, isOn: args.isOn },
      )
    }),
  },
})
