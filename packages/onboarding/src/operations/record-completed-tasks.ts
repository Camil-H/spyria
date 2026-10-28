import type { OnboardingTransactor } from '../contracts/transactor.ts'
import { tasksToRecordOf } from '../domain/tasks.ts'

type Dependencies = { transactor: OnboardingTransactor }

export const recordCompletedTasks = ({ transactor }: Dependencies) =>
  transactor.run(async ({ onboarding }) => {
    const facts = await onboarding.facts()
    const records = await onboarding.records()
    const permissions = await onboarding.permissions()
    for (const task of tasksToRecordOf(facts, records, permissions)) await onboarding.recordCompleted(task)
  })
