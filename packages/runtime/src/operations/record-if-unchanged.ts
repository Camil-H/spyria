import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import type { Runtime } from '../domain/runtime.ts'

export const recordIfUnchanged = (
  transactor: RuntimeTransactor,
  started: Runtime,
  record: (unitOfWork: UnitOfWork, current: Runtime) => Promise<void>,
) =>
  transactor.run(async (unitOfWork) => {
    const current = await unitOfWork.runtimes.lock(started.workspaceId, started.id)
    if (current.state === started.state && current.stateChangedAt === started.stateChangedAt)
      await record(unitOfWork, current)
  })
