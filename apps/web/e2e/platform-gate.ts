import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export default class PlatformGate implements Reporter {
  failedChecks: string[] = []

  onTestEnd(test: TestCase, result: TestResult) {
    const isPlatformCheck = test.parent.project()?.name === 'platform'
    if (isPlatformCheck && !['passed', 'skipped'].includes(result.status)) this.failedChecks.push(test.title)
  }

  onEnd() {
    if (this.failedChecks.length === 0) return
    console.log(
      `\nThe platform checks failed, so the other e2e tests did not run: the test stack itself (database reset, sync, agent stream or gateway) is broken, not a feature.\n${this.failedChecks.map((title) => `  ✗ ${title}`).join('\n')}\n`,
    )
  }
}
