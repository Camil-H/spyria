import { basename, dirname } from 'node:path'

type TestStatus = 'expected' | 'unexpected' | 'flaky' | 'skipped'
type Spec = { title: string; file: string; tests: { projectName: string; status: TestStatus }[] }
export type Suite = { specs?: Spec[]; suites?: Suite[] }

type Failure = { feature: string; line: string }

const failureOf = (spec: Spec): Failure[] => {
  const statuses = new Set(spec.tests.map((test) => test.status))
  if (!statuses.has('unexpected') && !statuses.has('flaky')) return []
  const feature = basename(dirname(spec.file))
  const flakyNote = statuses.has('unexpected') ? '' : ' (flaky: passed on retry)'
  return [{ feature, line: `${feature} › ${basename(spec.file)} › ${spec.title}${flakyNote}` }]
}

const failuresOf = (suite: Suite): Failure[] => [
  ...(suite.specs ?? []).flatMap(failureOf),
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
