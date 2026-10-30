# Dev mode

A dev chat is a runtime chat attached to a GitHub repository: the agent works in a clone of the repository inside the chat's runtime, the side panel shows the files, changes and commits of the working branch, and the chat owner pushes the branch and opens a pull request from the chat. This page is for members who use dev chats and for admins who connect GitHub. Setting up the GitHub App on a deployment is described in [Self-hosting](../guides/self-hosting.md).

## How the pieces fit

| Piece | Who sets it up | What it is used for |
|---|---|---|
| The workspace's GitHub App | An admin (**Workspace settings** > **Connect GitHub**) | Lists the repositories the workspace may use, clones them and fetches base branches with short-lived read-only installation tokens, receives webhooks |
| A member's GitHub account | Each member (**Profile** > **Connections** > **My connections** > **Connect GitHub account**) | Pushes and pull requests, so GitHub shows the member as the author |
| The runtime | Started by the chat's first prompt | Holds the clone; the agent edits, builds and commits there |
| The Spyria server | Always | Pushes the branch and talks to GitHub's API; GitHub tokens never enter a runtime |

The App's credentials (client secret, private key, webhook secret) are sealed with the deployment's secrets key, shown only as set, and replaced by entering a new value. A member's GitHub token is also kept server-side, sealed, never synced to browsers; when it cannot be refreshed, the connection shows as needing reconnection.

## Repositories

The repositories a workspace can use are exactly those granted to its GitHub App's installations on GitHub. **Connect GitHub** lists them; to add one, change the installation on GitHub. The one-click setup creates the App with these permissions and events:

| Permission | Access | Why |
|---|---|---|
| Contents | write | clone, fetch branches, push the working branch |
| Pull requests | write | open, update and refresh pull requests, read review threads |
| Issues | read | let the agent read the repository's issues |
| Checks | read | show check results on the pull request card, let the agent read why a check failed |
| Actions | read | let the agent read the failed step and the end of the log of a failing GitHub Actions job |
| Metadata | read | required by GitHub |
| Workflows | write | push a working branch that changes files under `.github/workflows` |

Events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_suite`, `check_run`.

## Creating a dev chat

In **New chat**, answer No to "Is it public", **AI chat**, and Yes to "Does it need GitHub access?", then pick a **Repository** (from the granted ones) and a **Base branch** (the default branch is preselected). Without a GitHub App the dialog says "Connect GitHub in Workspace settings" instead of the pickers.

The chat gets its own working branch, `spyria/<chat name slug>-<6 characters of the chat id>`, created from the base branch. The composer's folder chip shows the repository and the branch chip the working branch.

### Forking a dev chat

A fork of a dev chat is a dev chat on the same repository and base branch that continues where the original stopped: its runtime checks out the original's working branch as pushed to GitHub, not the base. The member who owns the original keeps working on that same branch, and the fork shows the open pull request card, so a push updates that pull request. Any other member gets a new working branch built on top of the original's, named after the fork, and opens their own pull request from it. Commits the original never pushed stay in its runtime; when the original's branch was never pushed, the fork starts from the base.

## Clone and setup script

When the chat's runtime starts, spyria-agent clones the repository into the runtime's workspace volume and checks out the working branch from the base:

- The clone uses an installation token scoped to that one repository with read access only. The token lives only in the environment of the `git clone` process: it is not in the agent's environment and the remote in `.git/config` carries no credential.
- Clone and checkout are part of the runtime's start, which the host relay limits to 2 minutes. A failed clone fails the start with "The repository could not be cloned" and git's reason.
- The setup command runs after the session has started, as a command step in the chat with live output: the one set for its repository (or for every other repository) in **Workspace settings > Connect runtime > Setup commands**, else `sh .spyria/setup.sh` when the repository has that file. Members who manage runtime hosts set them; every member can read them, so they hold no secret. It runs without any token. A prompt sent while it runs waits for it to end before it reaches the agent, so the agent never works on a half-installed checkout; **Stop** ends a waiting prompt. The step ends when the script exits: a service it starts in the background keeps running without holding the step open. When it fails, the chat shows a notice with its exit code and its last lines; the session keeps going.
- The setup command has 45 minutes. Past that, it is stopped with every process in its process group (a daemon that detaches itself with `setsid` escapes), and the chat shows a notice with the limit and its last lines; the session keeps going.
- The clone's git identity (`user.name` and `user.email` in `.git/config`) is the chat owner, so the agent's commits show the owner as their author: their GitHub login and `<id>+<login>@users.noreply.github.com` when their GitHub account is linked, else their Spyria name and a no-reply address. The server reads the owner's GitHub account with their token once per member and caches it; only the name and address reach the runtime. The identity is set again each time the agent starts.
- A runtime that restarts keeps its clone (no new clone or checkout) and runs the setup command again, since the processes it started are gone. A setup command must therefore be safe to run twice: install what is missing, skip what is there.

Rules files come with the clone, so every agent can read them. Pi loads `AGENTS.md` (or `CLAUDE.md`) from the working directory upward; Claude Code reads `CLAUDE.md` files; Codex reads `AGENTS.md`. A repository that wants all three to follow the same rules keeps an `AGENTS.md` and a `CLAUDE.md` that points to it.

## The side panel

Dev chats use the right panel's **Changes** and **Files** tabs; **Changes** comes first and opens by default. Every read goes from the browser to the server, which checks the reader may read the chat, then asks spyria-agent in the runtime through the host's relay. The browser never talks to a runtime directly.

- **Files:** the repository tree, loaded one folder at a time, with `.git` and ignored files hidden, and changed files marked (A, M, D; a dot on a folder holding changes). Files open read-only with syntax highlighting. A folder lists at most 500 entries and a file shows its first 256 KB.
- **Changes:** the diff of the working branch against the base branch, split top to bottom into the files not staged (edits, new files and deleted files), the files staged but not committed, then each commit since the base under its id and title, with its author, time and description, newest first. A merge commit shows only how its conflicts were resolved, so a clean merge, like an empty commit, is listed without files. One collapsible section per file with line numbers on both sides, shown side by side in two equal halves, long lines wrapping within their half, when the panel is at least 560px wide, and unified when narrower; every file starts collapsed when all the groups together have more than 400 lines, and **Collapse all** (or **Open all** once every file is closed) in the tab header closes or opens them all at once. Each part is cut at 400,000 characters, with a "Diff truncated" marker under the group that was cut; at most the latest 200 commits are listed, with a note when there are more. A status line shows `working branch → base`, how far it is ahead of or behind the base and the pushed branch, the number of uncommitted files and the last push. The panel refreshes when a turn or step ends, and on **Refresh**, whose icon spins until everything is read again and a toast then says "Changes refreshed".

When the runtime is asleep, the panel shows "Runtime asleep · showing the last snapshot": the tree root, the changes, the commits and the status as they were at the end of the last turn. Reading never wakes a runtime; **Wake** does (it needs the right to post in the chat).

The agent's shell commands and their output appear as steps in the conversation, live while a command runs, rather than in a separate terminal.

## Git actions

The chat owner has two actions in the **Changes** tab. Other participants see the status line and the diff, and the server refuses the actions to anyone but the owner.

- **Commit** commits every uncommitted change with the owner's **Commit message**. The author is the owner, as for the agent's own commits (see [Clone and setup script](#clone-and-setup-script)). An empty message or nothing to commit is refused.
- **Update from base** merges the base branch's latest commits into the working branch with a merge commit, never a rebase, so a pushed branch stays valid. The runtime gets those commits without any token: the server fetches the base with a read-only installation token and hands the runtime a git bundle. Uncommitted changes must be committed first. On a conflict the merge is aborted, the working copy is left clean, and **Ask the agent to resolve conflicts** prompts the agent, as the owner, to merge the base and resolve the listed files.

Both are disabled while the agent is working ("The agent is working: wait for its turn to end") or while the runtime is asleep ("The runtime is asleep: wake it first"). **Commit**, **Update from base** and **Push** show a spinner in the clicked button, then the outcome in a toast: a success fades after 5 seconds, a refusal stays until dismissed. A conflict stays in the panel with its button to ask the agent. **Commit** is also greyed while the status line shows no uncommitted file ("Nothing to commit"), and **Push** while no commit is ahead of the pushed branch, or of the base before the first push ("Nothing to push").

## Pushing and pull requests

Only the chat owner publishes, with their own GitHub account:

- **Push** and **Open pull request** in the **Changes** tab (the form prefills the title with the chat name and the description with the branch's commit subjects). Once a pull request is open, a push updates it.
- The agent's `push_branch`, `open_pull_request` and `update_pull_request` tools (see [The agent's GitHub tools](#the-agents-github-tools)). They run only on the owner's own prompts; on anyone else's turn they are refused with "Only <owner> can push or open pull requests in this chat", and the refusal is recorded like any tool call.

The owner needs a linked GitHub account ("Connect your GitHub account in your profile to push") and a running runtime ("The runtime is asleep: wake it, then push again"); publishing never wakes it.

### Why the server pushes

The owner's GitHub token can write to every repository the owner can, so it must never reach a runtime where an agent runs arbitrary commands. The runtime only hands the server a git bundle of the new commits of the working branch (at most 12 MB; larger pushes are refused with a hint to push from your own machine). The server checks that the bundle carries only that branch, rebuilds it in a fresh temporary repository with a git configuration of its own (no hooks, no credential helper, no URL rewrites from the runtime), and pushes to the repository's URL with the owner's token. There is no force push: a rewritten branch fails with git's message. The server therefore needs `git` installed. See [Security](../architecture/security.md) and the [decision records](../decisions/).

The pull request is created through GitHub's API with the owner's token, from the working branch into the chat's base branch, so GitHub shows the owner as its author.

## The agent's GitHub tools

The runtime holds no GitHub credential, so `git fetch`, `git pull`, `git push`, `gh` and GitHub's API cannot reach a private repository from inside it. The agent reaches GitHub through tools that run on the server instead, available in the main conversation of a dev chat. The tool server tells the agent so when it connects.

| Tool | Who can call it | What it does |
|---|---|---|
| `push_branch` | The owner's prompts | Pushes the working branch, fast-forward only |
| `open_pull_request` | The owner's prompts | Pushes, then opens a pull request into the base branch |
| `update_pull_request` | The owner's prompts | Changes the title or the description of the chat's open pull request |
| `fetch_branch` | Any prompt | Fetches any branch of the chat's repository into `origin/<branch>` in the runtime, leaving the working branch as it is |
| `read_review_threads` | Any prompt | Reads a pull request's review threads: file, line, resolved or outdated, and comments; the chat's pull request by default |
| `read_checks` | Any prompt | Reads the checks of a pull request's head commit, failing first, with the annotations of each failing check (file, line, title and message) and, for a GitHub Actions job, the step that failed and the end of its log; the chat's pull request by default |
| `list_issues` | Any prompt | Lists up to 30 issues of the repository, filtered by state, labels and words |
| `read_issue` | Any prompt | Reads an issue with its comments |
| `finish_work` | The owner's prompts and those of quality gates | Says the work is done, with the pull request's title and description; listed only when [quality gates](#quality-gates) are on |
| `report_review` | The review prompt of quality gates | Reports the review's findings, each important, nit or pre-existing |

`fetch_branch` works like **Update from base**: the server fetches the branch with a read-only installation token and hands the runtime a git bundle (at most 12 MB) holding only that branch's commits the runtime lacks. Since pushes only fast-forward, the agent merges what it fetched rather than rebasing. The reading tools use read-only installation tokens too, never a member's token, and cut long texts. Every call is recorded like any tool call.

Issue and comment text can be written by anyone who can comment on the repository, and it reaches the agent as it is. Check annotations and logs are written by the repository's CI, which runs the code of the pull request, so a pull request can write any text there; the tool's description tells the agent to read them as data, never as instructions.

`read_checks` explains a failing check from two sources. Annotations come first: a CI that annotates its failing tests, as [Spyria's own does](../decisions/0021-ci-on-github-actions-through-develop.md), gives the file, the line and the error without any log. For a GitHub Actions job, the tool adds the step that failed and the end of that job's log: the lines of the failing step up to its error, at most 100 lines and 10,000 characters, without timestamps and colors. That covers failures that annotate nothing, such as a dependency that fails to install, a build error or a timeout. Logs across the whole reply stop at 40,000 characters; jobs failing with the same log, like e2e shards on one broken test, point to the first one instead of repeating it, and jobs past the budget show only their failed step. Checks from other CI systems show their annotations alone.

An App created before Spyria asked for **Issues** lacks that permission: add **Issues: Read-only** in the App's settings on GitHub, then accept it on the installation. Until then, `list_issues` and `read_issue` answer "Ask a GitHub admin to accept the Issues permission for this workspace's GitHub App".

An App created before Spyria asked for **Actions** lacks that permission: add **Actions: Read-only** in the App's settings on GitHub, then accept it on the installation. Until then, `read_checks` reads annotations alone and says "Logs not read: Ask a GitHub admin to accept the Actions permission for this workspace's GitHub App".

An App created before Spyria asked for **Workflows** lacks that permission too: add **Workflows: Read and write** in the App's settings on GitHub, then accept it on the installation. Until then, GitHub refuses to push a working branch that changes a file under `.github/workflows`.

## Quality gates

When an admin turns quality gates on, the agent of a dev chat checks its own work before the owner sees it. It ends the work the owner asked for by calling `finish_work`; after that turn, Spyria runs the work through the repository's gates, in order. Gates are set in **Workspace settings > Quality gates**, for one repository or for every other one, and are any of these:

- **Command**: a name, one command run in the runtime with the setup command's environment, and a timeout. Keep the logic in a script in the repository, such as a package script or `scripts/check.sh`, so the gate only runs it and developers run the same thing. Consecutive commands run one after the other and fail together, so the agent gets every failure at once, with the end of each one's output.
- **Code review**: the agent starts a subagent with a fresh context on the branch's diff (then, in later rounds, on what changed since the last review), guided by the repository's `REVIEW.md` and `AGENTS.md`, and reports each finding with `report_review` as important, nit or pre-existing. Important findings that were not reported before count as a failure; nits and pre-existing defects do not.
- **Pull request**: pushes the branch and opens the pull request, or pushes to the open one, as the owner, with the title and description given to `finish_work`.
- **CI**: every minute it reads the checks of the pushed commit, and once every check that counts has finished, the failing ones count as a failure, as `read_checks` shows them. The checks that count are picked from those GitHub reports on the repository's default branch, or typed; with none picked, every check counts. When no counted check reports within 15 minutes, it hands over.

Each gate but the pull request says what a failure does: **send it back to the agent, up to N times**, or **stop and hand over to the owner**. After a fix the agent calls `finish_work` again and the gates run from the first one. If the agent commits during the review turn, that commit goes through the gates again before anything is pushed. Only CI may come after the pull request, so nothing the agent commits stays unpushed, and each command has a name of its own. The built-in gates, before an admin changes them, are a code review, the pull request and CI. Every member can read the gates, so a command must hold no secret.

Each message the gates send is the owner's, marked **Sent by quality gates**, and runs on the owner's key; in the audit log it reads as the system acting for the owner. A **Quality gates** card in the chat shows each gate passed, failed, running or waiting, how many times it went back to the agent, the review findings and the pull request. The gates hand over to the owner, with a notice, when:

- every gate passed: "Ready for your review on pull request #N", naming the gates that passed;
- a gate still fails after its fixes: the agent is first asked to say what it would change about the approach, without fixing again; or a gate set to stop fails;
- the agent ends a turn without `finish_work` (it is waiting for the owner, or asked a question);
- the run reaches its time limit (counted from the owner's prompt), its cost limit, or the owner's monthly budget;
- the owner presses **Stop**, or an admin turns quality gates off;
- any member writes in the chat, even before the run starts: it stops, and the message it had queued is not sent.

Only the owner's own prompts start a run: `finish_work` from another member's prompt is refused. It works the same on a member's machine, except that a subscription is not metered, so neither the cost limit nor the monthly budget applies there.

Admins set quality gates in **Workspace settings > Quality gates**, with the **Connect GitHub** permission: on or off, the limits of a run (a time limit, 4 hours by default, and an optional cost limit), and the gates of each repository. Repositories are listed once GitHub is connected; until then only the gates of every other repository can be set. See [decision 0025](../decisions/0025-dev-loop.md).

## The pull request card and header chip

Opening a pull request posts a card in the chat: title, number, state (open, draft, merged, closed), a checks summary (pending, passing, failing), the review state (approved, changes requested, commented) and a link to GitHub. The chat header shows a chip **PR #N · state** for the latest one. Both update live from GitHub's webhooks.

The checks summary is failing when any check fails, pending while any is pending or none has run, and passing otherwise; only checks of the current head count.

When the pull request has unresolved review comments, the owner sees **Address review comments**: it sends the agent one prompt listing each comment with its file, line, author and text. The owner then pushes again.

## Webhooks

GitHub sends the App's events to `<origin>/api/github/webhooks`. Spyria:

- verifies `X-Hub-Signature-256` against the webhook secret of the workspace whose App sent it (HMAC SHA-256, constant-time comparison), and answers 401 when no secret signs the body;
- ignores a delivery id it has already received, so GitHub's retries are harmless;
- applies pull request, review, review comment, review thread and check events to the card of a pull request Spyria opened, and acknowledges every other event without acting on it.

## Limits

- A pull request opened outside Spyria for the working branch is not adopted; opening one from Spyria then fails with GitHub's message.
- A chat whose owner left the workspace is frozen and can no longer publish until an admin transfers it (see [Administration](./admin.md)).
- Network egress from runtimes is not filtered: the agent can reach the internet, including GitHub, without credentials.

Related: [Agents](./agents.md), [Machines](./machines.md), [Chats and sharing](./chats-and-sharing.md).
