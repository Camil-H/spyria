# 0021. CI on GitHub Actions, with `main` fed from a tested `develop`

## Context

Spyria's repository is public, and pull requests come from members, outside contributors and agents in dev chats. The full suite (`check:all`, and `check:docker` for the host and images) takes long, mostly in Playwright, so running all of it on every push wastes time, and running only a part of it lets a change that the selection missed reach `main`. Agents that open pull requests need to read why a check failed without parsing raw logs.

## Decision

- CI runs on GitHub Actions, on the standard hosted runners, which are free for public repositories. There are no self-hosted runners: a pull request from a fork would run its code on our machine. Tests need no secrets ([0018](0018-tests-on-their-own-stack.md)), and the only secret is the deploy key that pushes to `main`, used by that job alone; workflows use `pull_request`, never `pull_request_target`, default to `permissions: contents: read`, and pin third-party actions by commit SHA.
- `develop` is the default branch and every pull request targets it. `main` only receives commits that passed the full suite: every hour, and on demand, a promotion workflow fast-forwards `main` to the newest commit of `develop`'s own history (first parents) whose full run passed, skipping newer commits whose run is pending, failed, cancelled or missing. It pushes with a deploy key that is the only actor allowed to update `main`, and never merges or forces: if `main` is not an ancestor, the push fails and nothing changes. Releases are cut from `main`.
- On a pull request, the fast checks (lint, typecheck, boundaries, locks) always run; the tests are those `check:related` selects against the merge base with `develop`, with e2e chosen by segment from the changed code; `check:docker` runs when the host, the agent, the images or `infra` change. New or changed specs run three times to catch flakiness before the merge. One `ci-ok` job, which counts skipped jobs as passed, is the only required check.
- On every push to `develop`, the full suite runs. Runs on `develop` queue rather than cancel each other (one running, the newest push waiting), so they finish and leave passing commits to promote even when merges come faster than a run; on a pull request, a newer push cancels the run in progress. A failure is commented, with its summary, on each pull request merged since the last passing commit, and is fixed forward or reverted at once.
- e2e is sharded across jobs, two workers each, rather than many workers on one runner.
- CI retries a failed test once (local runs never retry) to tell a flaky test from a broken one, and a test that passes only on retry still fails the run; it is fixed or deleted when found. There is no quarantine.
- Each failing job annotates its check run with every failing test: file, line, name and the first lines of the error, through GitHub's `::error` workflow commands (Playwright's `github` reporter for e2e, `scripts/ci-suite.ts` from Bun's JUnit report for unit and integration). Spyria reads them with the `checks: read` permission it already has and gives them to the agent as untrusted tool output, never as instructions. Playwright attachments are kept 7 days for people.
- Annotations only exist where a reporter writes them, and most repositories' CI writes none, so Spyria also reads, with `actions: read`, the step that failed in a GitHub Actions job and the end of its log: the failing step's lines up to its error, cut to 100 lines. That explains the failures no reporter sees (an install, a build, a timeout) in any repository on Actions, without parsing whole logs. Other CI systems only get their annotations: their logs live outside GitHub.

## Consequences

- `main` is always a commit that passed the full suite and lags `develop` by up to an hour plus a run; `develop` can be red between a merge and its fix, and nothing after the red commit reaches `main` until a later commit passes.
- A failure the selection missed is found after the merge into `develop`, not before; the comment on the merged pull requests brings it back to their authors and dev chats.
- `check:related` is the single test selection, used locally and in CI.
- The repository settings are part of this decision: `develop` is the default branch and requires `ci-ok` before a merge; `main` accepts no update but the deploy key's fast-forward.

## Alternatives considered

- Paid or faster runners: possible later by changing `runs-on`, not needed while standard runners are free.
- A merge queue: tests each merge before it lands, but needs the repository to belong to an organization.
- The full suite on every pull request push, with branches required to be up to date: throws away test selection and reruns every open pull request after each merge.
- A nightly full run: finds a failure up to a day late, after it reached `main`.
- Promoting at the end of each passing run on `develop`, with newer pushes cancelling older runs: when merges come faster than a run, every run is cancelled and `main` never moves.
