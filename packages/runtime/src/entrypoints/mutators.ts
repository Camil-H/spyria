import { type RuntimeHostId, runtimeHostId, type WorkspaceId } from '@hq/kernel'
import { defineMutator, defineMutators } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { NotCurrentWorkspace } from '../domain/errors.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { removeRuntimeHost } from '../operations/remove-runtime-host.ts'

const hostArguments = z.object({
  workspaceId: z.string().check(z.minLength(1)),
  hostId: z.pipe(z.string().check(z.minLength(1)), z.transform(runtimeHostId)),
})

type HostRemoved = (workspaceId: WorkspaceId, hostId: RuntimeHostId) => void

export const createRuntimeMutators = (onHostRemoved: HostRemoved = () => {}) =>
  defineMutators({
    runtime: {
      removeHost: defineMutator(hostArguments, async ({ tx, ctx, args }) => {
        if (args.workspaceId !== ctx.workspaceId) throw new NotCurrentWorkspace()
        await removeRuntimeHost(
          { transactor: createZeroTransactor(tx) },
          { workspaceId: ctx.workspaceId, role: ctx.role, hostId: args.hostId, now: Date.now() },
        )
        onHostRemoved(ctx.workspaceId, args.hostId)
      }),
    },
  })

export const runtimeMutators = createRuntimeMutators()
