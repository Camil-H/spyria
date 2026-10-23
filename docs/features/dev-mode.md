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
| Contents | write | clone, fetch the base branch, push the working branch |
| Pull requests | write | open and refresh pull requests |
| Checks | read | show check results on the pull request card |
| Metadata | read | required by GitHub |

Events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_suite`, `check_run`.

## Creating a dev chat

**New chat** > **Runtime** > **Dev**, then pick a **Repository** (from the granted ones) and a **Base branch** (the default branch is preselected). Without a GitHub App the dialog says "Connect GitHub in Workspace settings" instead of the pickers.

The chat gets its own working branch, `spyria/<chat name slug>-<6 characters of the chat id>`, created from the base branch. The composer's folder chip shows the repository and the branch chip the working branch.

## Clone and setup script

When the chat's runtime starts, spyria-agent clones the repository into the runtime's workspace volume and checks out the working branch from the base:

- The clone uses an installation token scoped to that one repository with read access only. The token lives only in the environment of the `git clone` process: it is not in the agent's environment and the remote in `.git/config` carries no credential.
- Clone and checkout are part of the runtime's start, which the host relay limits to 2 minutes. A failed clone fails the start with "The repository could not be cloned" and git's reason.
- If the repository has `.spyria/setup.sh`, it runs after the session has started, as a command step in the chat with live output, alongside the first turn. It runs without any token. When it fails, the chat shows a notice with its exit code and its last lines; the session keeps going.
- A runtime that restarts keeps its clone: no new clone, checkout or setup.

Rules files come with the clone, so every agent can read them. Pi loads `AGENTS.md` (or `CLAUDE.md`) from the working directory upward; Claude Code reads `CLAUDE.md` files; Codex reads `AGENTS.md`. A repository that wants all three to follow the same rules keeps an `AGENTS.md` and a `CLAUDE.md` that points to it.

## The side panel

Dev chats use the right panel's **Files**, **Changes** and **Commits** tabs. Every read goes from the browser to the server, which checks the reader may read the chat, then asks spyria-agent in the runtime through the host's relay. The browser never talks to a runtime directly.

- **Files:** the repository tree, loaded one folder at a time, with `.git` and ignored files hidden, and changed files marked (A, M, D; a dot on a folder holding changes). Files open read-only with syntax highlighting. A folder lists at most 500 entries and a file shows its first 256 KB.
- **Changes:** the diff of the working branch against the base branch, including commits, uncommitted edits and new files. One collapsible section per file with line numbers on both sides, shown side by side when the panel is at least 560px wide and unified when narrower; every file starts collapsed when the diff has more than 400 lines. A very large diff is cut with a visible "truncated" marker. A status line shows `working branch → base`, how far it is ahead of or behind the base and the pushed branch, the number of uncommitted files and the last push. The panel refreshes when a turn or step ends, and on **Refresh**.
- **Commits:** the commits of the working branch since the base.

When the runtime is asleep, the panel shows "Runtime asleep · showing the last snapshot": the tree root, the changes and the status as they were at the end of the last turn. Reading never wakes a runtime; **Wake** does (it needs the right to post in the chat).

The agent's shell commands and their output appear as steps in the conversation, live while a command runs, rather than in a separate terminal.

## Git actions

The chat owner has two actions in the **Changes** tab. Other participants see the status line and the diff, and the server refuses the actions to anyone but the owner.

- **Commit** commits every uncommitted change with the owner's **Commit message**. The author is the owner's GitHub name and email when their account is linked, else their Spyria name and a no-reply address. An empty message or nothing to commit is refused.
- **Update from base** merges the base branch's latest commits into the working branch with a merge commit, never a rebase, so a pushed branch stays valid. The runtime gets those commits without any token: the server fetches the base with a read-only installation token and hands the runtime a git bundle. Uncommitted changes must be committed first. On a conflict the merge is aborted, the working copy is left clean, and **Ask the agent to resolve conflicts** prompts the agent, as the owner, to merge the base and resolve the listed files.

Both are disabled while the agent is working ("The agent is working: wait for its turn to end") or while the runtime is asleep ("The runtime is asleep: wake it first").

## Pushing and pull requests

Only the chat owner publishes, with their own GitHub account:

- **Push** and **Open pull request** in the **Changes** tab (the form prefills the title with the chat name and the description with the branch's commit subjects). Once a pull request is open, a push updates it.
- The agent's `push_branch` and `open_pull_request` tools, available in the main conversation of a dev chat. They run only on the owner's own prompts; on anyone else's turn they are refused with "Only <owner> can push or open pull requests in this chat", and the refusal is recorded like any tool call.

The owner needs a linked GitHub account ("Connect your GitHub account in your profile to push") and a running runtime ("The runtime is asleep: wake it, then push again"); publishing never wakes it.

### Why the server pushes

The owner's GitHub token can write to every repository the owner can, so it must never reach a runtime where an agent runs arbitrary commands. The runtime only hands the server a git bundle of the new commits of the working branch (at most 12 MB; larger pushes are refused with a hint to push from your own machine). The server checks that the bundle carries only that branch, rebuilds it in a fresh temporary repository with a git configuration of its own (no hooks, no credential helper, no URL rewrites from the runtime), and pushes to the repository's URL with the owner's token. There is no force push: a rewritten branch fails with git's message. The server therefore needs `git` installed. See [Security](../architecture/security.md) and the [decision records](../decisions/).

The pull request is created through GitHub's API with the owner's token, from the working branch into the chat's base branch, so GitHub shows the owner as its author.

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
