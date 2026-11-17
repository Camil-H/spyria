import { basename, dirname } from 'node:path'

type TestStatus = 'expected' | 'unexpected' | 'flaky' | 'skipped'
type Spec = { title: string; file: string; tests: { projectName: string; status: TestStatus }[] }
export type Suite = { specs?: Spec[]; suites?: Suite[] }

type Failure = { feature: string; line: string }

const failuresOf = (suite: Suite): Failure[] => [
  ...(suite.specs ?? []).flatMap((spec) =>
    spec.tests
      .filter((test) => test.status === 'unexpected' || test.status === 'flaky')
      .map((test) => {
        const feature = basename(dirname(spec.file))
        const flakyNote = test.status === 'flaky' ? ' (flaky: passed on retry)' : ''
        return { feature, line: `${feature} › ${basename(spec.file)} › ${spec.title}${flakyNote}` }
      }),
  ),
  ...(suite.suites ?? []).flatMap(failuresOf),
]

export const failuresSummaryOf = (heading: string, report: Suite | undefined) => {
  if (!report)
    return `### ${heading}\n\nPlaywright wrote no report: the run stopped before the tests, see the job log.\n`
  const failures = failuresOf(report)
  if (failures.length === 0)
    return `### ${heading}\n\nNo test failed: the run failed outside the tests, see the job log.\n`
  const sections = [...Map.groupBy(failures, (failure) => failure.feature)]
    .toSorted(([first], [second]) => first.localeCompare(second))
    .map(
      ([feature, featureFailures]) => `**${feature}**\n\n${featureFailures.map(({ line }) => `- ${line}`).join('\n')}`,
    )
  const platformNote = failures.some((failure) => failure.feature === '00-platform')
    ? '\n\nThe platform checks failed, so the other tests did not run: the test stack is broken, not a feature.'
    : ''
  const count = failures.length === 1 ? '1 failing test' : `${failures.length} failing tests`
  return `### ${heading}: ${count}${platformNote}\n\n${sections.join('\n\n')}\n`
}
