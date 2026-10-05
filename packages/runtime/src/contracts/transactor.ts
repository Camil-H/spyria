import type { RuntimeHostRepository } from './repositories.ts'

export type UnitOfWork = { runtimeHosts: RuntimeHostRepository }

export type RuntimeTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
