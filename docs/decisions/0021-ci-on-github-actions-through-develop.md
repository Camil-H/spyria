# 0021. CI on GitHub Actions, with `main` fed from a tested `develop`

## Context

Spyria's repository is public, and pull requests come from members, outside contributors and agents in dev chats. The full suite (`check:all`, and `check:docker` for the host and images) takes long, mostly in Playwright, so running all of it on every push wastes time, and running only a part of it lets a change that the selection missed reach `main`. Agents that open pull requests need to read why a check failed without parsing raw logs.

## Decision

- CI runs on GitHub Actions, on the standard hosted runners, which are free for public repositories. There are no self-hosted runners: a pull request from a fork would run its code on our machine. CI holds no secrets ([0018](0018-tests-on-their-own-stack.md)); workflows use `pull_request`, never `pull_request_target`, default to `permissions: contents: read`, and pin third-party actions by commit SHA.
- `develop` is the default branch and every pull request targets it. `main` only receives commits that passed the full suite: when the full suite passes on a commit of `develop`, the workflow fast-forwards `main` to that commit, and only that workflow may push to `main`. Releases are cut from `main`.
- On a pull request, the fast checks (lint, typecheck, boundaries, locks) always run; the tests are those `check:related` selects against the merge base with `develop`, with e2e chosen by segment from the changed code; `check:docker` runs when the host, the agent, the images or `infra` change. New or changed specs run three times to catch flakiness before the merge. One `ci-ok` job, which counts skipped jobs as passed, is the only required check.
- On every push to `develop`, the full suite runs; a newer push cancels the run in progress, since its commit contains the older one. A failure is commented, with its summary, on each pull request merged since the last passing commit, and is fixed forward or reverted at once.
- e2e is sharded across jobs, two workers each, rather than many workers on one runner.
- CI retries a failed test once (local runs never retry); a test that passes only on retry is listed as flaky in the summary and is fixed or deleted when found. There is no quarantine.
- Each failing job writes a summary for agents into its check run's output: the failing step, the failing tests with file and line, and their trimmed output. Spyria reads it from the `check_run` webhook with the `checks: read` permission it already has, and gives it to the agent as untrusted tool output, never as instructions. Playwright attachments are kept 7 days for people.

## Consequences

- `main` is always a commit that passed the full suite; `develop` can be red between a merge and its fix, and nothing reaches `main` meanwhile.
- A failure the selection missed is found after the merge into `develop`, not before; the comment on the merged pull requests brings it back to their authors and dev chats.
- `check:related` is the single test selection, used locally and in CI.
- The repository settings are part of this decision: `develop` is the default branch and requires `ci-ok` before a merge; `main` accepts no direct push, only the fast-forward of the workflow.

## Alternatives considered

- Paid or faster runners: possible later by changing `runs-on`, not needed while standard runners are free.
- A merge queue: tests each merge before it lands, but needs the repository to belong to an organization.
- The full suite on every pull request push, with branches required to be up to date: throws away test selection and reruns every open pull request after each merge.
- A nightly full run: finds a failure up to a day late, after it reached `main`.
