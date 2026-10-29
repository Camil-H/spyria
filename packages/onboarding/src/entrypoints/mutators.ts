import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import type { ZeroContext } from '@spyria/db/zero-queries'
import { z } from 'zod/mini'
import { NotOwnOnboarding } from '../domain/errors.ts'
import { onboardingTasks } from '../domain/tasks.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { recordCompletedTasks } from '../operations/record-completed-tasks.ts'
import { skipTask } from '../operations/skip-task.ts'

const workspaceArguments = z.object({ workspaceId: z.string().check(z.minLength(1)) })
const taskArguments = z.extend(workspaceArguments, { task: z.enum(onboardingTasks) })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new NotOwnOnboarding()
  return { transactor: createZeroTransactor(tx, context) }
}

export const onboardingMutators = defineMutators({
  onboarding: {
    recordCompletedTasks: defineMutator(workspaceArguments, ({ tx, ctx, args }) =>
      recordCompletedTasks(dependenciesOf(tx, ctx, args)),
    ),
    skipTask: defineMutator(taskArguments, ({ tx, ctx, args }) => skipTask(dependenciesOf(tx, ctx, args), args)),
  },
})
