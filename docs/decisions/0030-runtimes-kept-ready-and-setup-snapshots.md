# 0030. Runtimes kept ready and setup snapshots per repository

## Context

A dev chat's runtime clones its repository and runs the setup command before the agent gets a message ([0025](0025-dev-loop.md)). The package cache per repository and owner makes a second `bun install` read from disk, but every new chat still waits for a container, a clone and the whole setup: on a large repository, minutes before the first answer. Hosted coding agents hide that wait with pre-started sandboxes and an image taken after setup.

A runtime is where an agent runs arbitrary commands with the rights of whoever prompts it. Whatever a new chat starts from must therefore be something no chat could have changed, or one member's agent could plant code in another member's next chat. That is why the package cache is per owner.

## Decision

- **Admins keep runtimes ready per repository.** Next to a repository's own setup command, members who manage runtime hosts set **Runtimes kept ready**, 0 to 5. Spyria keeps that many runtimes started on workspace hosts, each with the repository's default branch cloned and the setup command run. Members' own machines never hold one.
- **A runtime kept ready belongs to no chat and no member.** It is a row of `warm_runtimes`, not of `runtimes`. It mounts no package cache, gets a read-only installation token for its clone only, and no agent runs in it until a chat takes it. A new dev chat whose repository, base branch and setup command match takes a ready one in the same transaction that would have placed a new runtime. The runtime becomes the chat's, already running, and Spyria starts another one. The chat fetches its base, creates its working branch and starts the agent without running setup again, unless the base moved since setup or setup failed.
- **The snapshot is taken only from a runtime kept ready, after its setup, before any chat has it.** The host pauses the runtime while a container with no network copies its project and home, mounted read-only, into a new volume per repository and setup command. Every later runtime of that repository on that host mounts the newest snapshot read-only, and restores from it instead of cloning, then fetches, branches and runs setup, which then has little left to do. A snapshot is never taken from a chat's runtime, since that would carry one chat's work, history or planted code into the next chats. It is not shared across hosts: it is a local volume, like the runtimes.
- **They converge on the settings.** One job fills the pools: when setup commands change, a host connects, a chat takes a runtime, and on each sweep of a workspace that keeps some ready. It replaces a runtime whose setup command or runtime image changed, or that has been ready for a day, so the clone and installs do not drift far from the default branch. It never takes a host's last slot, so a chat always finds room. A host going offline or removed drops its runtimes kept ready. The host keeps only the newest snapshot of each repository still kept ready.
- **Host protocol 4 and agent protocol 2**, the minimums: the server sends snapshot keys and commands that older hosts refuse, and asks spyria-agent to prepare a runtime.

## Consequences

- A new dev chat on a repository with runtimes kept ready answers as fast as a chat without a repository, while one is ready. When none is left, it still starts from the snapshot on its host, if there is one.
- Runtimes kept ready count against hosts' runtimes, and use memory and disk while nobody uses them. Each snapshot is another copy of the project and of what setup installed on each host.
- What setup installed goes into the snapshot. A setup command that writes a secret to disk would hand it to every chat of the repository: setup commands already hold no secret ([0025](0025-dev-loop.md)), and setup runs with no token.
- A runtime taken by a chat has no package cache mount until it is recreated, since mounts are fixed when a container is created.
- Pausing needs the cgroup freezer, which Docker on Linux, rootless or not, and Docker Desktop provide. A failed snapshot leaves the runtime ready without one.

See [Dev mode](../features/dev-mode.md#runtimes-kept-ready) and [Machines](../features/machines.md).
