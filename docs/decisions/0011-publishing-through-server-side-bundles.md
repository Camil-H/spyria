# 0011. Publishing goes through server-side bundles

## Context

Dev chats edit a repository inside a runtime and end in a branch and a pull request. Pushing from inside the runtime would put a GitHub token where an agent, and anything it runs, can read it. Pushing with a shared bot account would hide who authored the change.

## Decision

- The workspace's GitHub App clones with a short-lived, read-only installation token for that one repository, passed to `git` as a one-off header, never left in the environment or `.git/config`.
- Only the chat **owner** publishes, with their own linked GitHub account, and only on their own action: their button, or the agent's push and pull request tools on the owner's own prompts. Other participants can prompt edits but cannot push.
- To publish, the runtime hands the server a git bundle of the working branch; the server pushes it with the owner's token. No force push.

## Consequences

- No GitHub token ever enters a runtime, so a compromised agent has nothing to push with.
- GitHub shows the owner as the author of the branch and pull request.
- The server needs `git` installed, and bundles have a size cap.

See [dev mode](../features/dev-mode.md).
