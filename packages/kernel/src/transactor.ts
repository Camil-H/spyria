export type Transactor<UnitOfWork> = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
