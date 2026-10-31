# Machines

This page explains where agent chats run: on the workspace's runtime hosts, or on a member's own machine for Claude Code and Codex subscriptions. It covers adding a host, adding your machine, signing in to a harness, the admin switch for members' machines, and how runtimes are isolated. It is for admins who run hosts and members who use their own machine. Installing and operating the server is in [Self-hosting](../guides/self-hosting.md); a host for local development is in [Development](../guides/development.md).

## Runtime hosts and runtimes

A **runtime** is one container per runtime chat, made from Spyria's runtime image: `spyria-agent`, Pi, node and npm, git and ripgrep. A **runtime host** is any machine with Docker that runs the host program, `spyria-host`. The host dials out to Spyria over a WebSocket and carries out a fixed set of commands (create, start, stop, remove a runtime, report status). Spyria never connects into the host, so a host needs no open port and Spyria never holds a key to it. See [Decisions](../decisions/).

There are two kinds of host:

| | Workspace runtime host | A member's machine |
|---|---|---|
| Added by | an admin, in **Workspace settings > Connect runtime** | the member, in **Profile > My machine** |
| Runs | Pi sessions of any member's runtime chats | only its owner's Claude Code and Codex sessions |
| Model calls | the prompter's API key through Spyria's gateway | the owner's subscription, directly from the machine |
| Started with | `spyria-host <claim URL>` | `spyria-host --personal <claim URL>` |

Hosts never pull images: the runtime image is built on the server's machine with `bun run agent:build`, and each host must hold it. Until it is built, a prompt answers "Spyria's runtime image is not built: run bun run agent:build".

## Adding a workspace runtime host

1. As an admin, open **Workspace settings**, **Connect runtime**, then **Add runtime host**, give it a name and copy the command.
2. Run the command on the machine. It starts the `spyria-host` container with all capabilities dropped, `no-new-privileges`, a read-only root filesystem and a state volume, gives it the Docker socket (rootless or rooted, detected by the command), and passes a single-use claim URL. When Spyria's origin is `localhost` (local development), the command builds the host image itself and points the container at `host.docker.internal`.
3. The row turns **Online** within seconds, and the command dialog closes by itself. The claim code expires after 15 minutes (**Code expired**); **New command** issues a fresh one. Once paired, the host keeps its own token in its state volume.

Each host row shows its CPUs, memory, how many runtimes run against its cap, and badges: **Docker: rootless** or **Docker: root** (a rooted daemon has root on the host, even though containers are isolated), and **Limits not enforced** when Docker cannot apply memory and process limits on that machine. **Remove** disconnects a host and revokes its token.

## Removing a host

Removing a host (or a member's machine) disconnects it: `spyria-host` logs "This host was removed", turns off its container's restart policy so Docker does not restart it, and stops. Its runtimes show **Could not start** in their chats. Nothing is deleted on the machine: the stopped host container, the runtime containers and their volumes stay until you remove them there, here for the default deployment `spyria`:

```sh
docker rm -f spyria-host
docker rm -f $(docker ps -aq --filter label=spyria.managed=1 --filter name=^spyria-rt-)
docker volume rm $(docker volume ls -q --filter name=^spyria-rt-)
docker volume rm $(docker volume ls -q --filter name=^spyria-cache-)
docker network rm $(docker network ls -q --filter label=spyria.managed=1 --filter name=^spyria-rt-)
docker volume rm spyria-host
```

The runtime volumes hold the files the agents worked on, so remove them only once nothing in them is needed; the package caches only hold downloads, and runtimes do not remove them when they are removed. With another deployment name, replace `spyria-` with `<deployment>-`; the name filter keeps another deployment's runtimes on the same Docker daemon. On a member's machine, the sign-ins (`spyria-cred-claude-code`, `spyria-cred-codex`) and installed harnesses (`spyria-harnesses`) stay too; `docker volume rm` them if the machine is not added again.

## Where a chat runs

A Spyria runtime is placed on the least loaded online workspace host that has room. A host's cap is one runtime per GiB of memory above the first 2 GiB. When no host is online the chat says "No runtime host is available"; when the chosen host goes offline, "The runtime host is offline".

The runtime's status shows in the chat: **Not started**, **Starting…**, **Installing** *tool*…, **Ready**, **Sleeping**, **Host offline**, **Could not start**. A runtime idle for an hour is stopped (**Sleeping**) and starts again on the next prompt with its files intact; the panel shows the last snapshot of its files while it sleeps. A runtime stopped or failed for 30 days is removed.

When the runtime is **Ready**, the chat's owner and Editors can open the status as a menu:

- **Restart session** keeps the runtime running but starts a fresh agent process and reloads the conversation into it. The chip reads **Restarting…** until the new session has started, then **Session restarted** for a few seconds; when no session was running, or the agent could not restart it, it reads **New session on your next message** instead. Use it when the agent stops answering, for example after its process died.
- **Stop runtime** puts the runtime to sleep as the idle stop does; the next prompt starts it again.

While the agent is working, both ask for confirmation, because they stop the current turn. Other participants see the status without the menu, and the server refuses both actions to them.

When an agent's Claude Code or Codex process dies, `spyria-agent` restarts it and reloads the conversation on its own. A prompt that failed before the agent wrote anything is sent again once; otherwise the chat says "The agent restarted; send your message again", with the last line the agent printed. That output is redacted like the rest of the agent's output and kept in the agent's logs.

Each runtime has three volumes (its workspace, its home and its temporary directory), plus, for a dev chat, the package cache its owner shares across their runtimes on the same repository (`<deployment>-cache-*`), a 2 GiB memory limit, 2 CPUs and 512 processes, runs as a non-root user, and has all capabilities dropped and a read-only root filesystem.

## Isolation and egress

Each runtime gets its own Docker bridge network, which the host joins to relay the runtime's model and tool calls to Spyria. Runtimes on one host therefore cannot reach each other where Docker enforces isolation between networks (Docker Engine on Linux; some desktop Docker products allow traffic between networks).

The model calls a runtime makes go to its host, which relays them to Spyria; Spyria runs them in the gateway on the prompting member's key. A runtime holds only a per-runtime token that Spyria issues, never a member's key, and never a GitHub token. See [Security](../architecture/security.md).

Spyria does not filter runtimes' outbound traffic. On a cloud host, block the metadata endpoint (`169.254.169.254`) and private address ranges in the provider's firewall.

## A member's own machine

A member can run Claude Code on their Claude subscription, or Codex on their ChatGPT plan, on their own computer. The sign-in stays on that computer: Spyria never sees it.

1. Open **Profile**, **My machine**, then **Use Claude Code** or **Use Codex** (or **Add my machine**). Copy the command and run it on your computer. It ends with `spyria-host --personal <claim URL>`, followed by the sign-in command for the tool you chose.
2. Sign in once, in a terminal:
   - Claude Code: `docker exec -it spyria-host spyria-host login claude-code`, open the printed URL, sign in and paste the code.
   - Codex: `docker exec -it spyria-host spyria-host login codex`, open the printed URL and enter the one-time code. ChatGPT may ask you to enable device code sign-in first, in its **Security** settings.
3. The dialog closes and the button turns to "✓ Claude Code connected" (or Codex) as soon as the sign-in ends. In a new runtime chat, set **Runs on** to **Local · Claude Code** or **Local · Codex**.

The sign-in waits until `spyria-host --personal` has connected to Spyria once ("Waiting for spyria-host to connect to Spyria…"), since Spyria tells it which runtime image to sign in with. If it never connects, the sign-in stops after 15 minutes and points to `docker logs spyria-host`.

The container name follows the deployment name (`<deployment>-host`); the default deployment is `spyria`, so the commands above use `spyria-host`. The commands Spyria shows always carry the right name.

**Never run it on a machine others use.** The agent on that machine runs as you and can read your Claude and ChatGPT sign-ins.

When your machine shows **Offline** (Docker was not running when your computer started, or the container was stopped), **Start** shows the command that starts it again, `docker start spyria-host`; it reconnects within seconds, and the dialog closes by itself once the machine is online. If it stays offline, **Set up again** gives a new command that installs it afresh: the old connection stops working, and your sign-ins are kept.

### Sign-ins

Each tool's sign-in lives in its own Docker volume on your machine (`<deployment>-cred-claude-code`, `<deployment>-cred-codex`) and survives runtimes being removed. `spyria-host logout claude-code` or `spyria-host logout codex` (through `docker exec -it`, as above) deletes it. Logging out of Codex is local only; to also end the session at OpenAI, log out of all devices in ChatGPT's **Security** settings. When a sign-in expires, the chat says "Authentication required — sign in to *tool* again".

Tokens that show up in the agent's output (for example if it prints its own credentials file) are replaced with `[redacted]` before the events leave your machine.

### Harness install on first use

Claude Code, Codex and their adapters are not in the runtime image. Their versions are pinned in `apps/host/src/harnesses.json`, and your machine's `spyria-host` installs the pinned set the first time it is needed, at `login` or when a session starts (the chat shows **Installing Claude Code…**). The install goes into the `<deployment>-harnesses` volume, one folder per pinned set, mounted read-only into sessions. `SPYRIA_HARNESS_REGISTRY` points the install at another npm registry.

### What a machine session does and does not do

- Only the owner prompts; other participants read. Questions and steps work as in [Agents](./agents.md).
- The tool runs on your plan's models, chosen in the session chip; Spyria does not route, meter or budget it.
- The agent's tools (MCP) still go through Spyria's gateway, as the chat owner.
- If your machine is offline, prompts wait with "Your machine is offline".
- If your machine is online but cannot reach the internet, a Codex session waits about 20 to 30 seconds before it starts: Codex first tries to fetch its model list and your ChatGPT workspace, then gives up. The turn then fails, since Codex needs ChatGPT to answer.

## Turning members' machines off

Admins control this for the workspace with the switch **Members can run sessions on their own machine** in **Workspace settings > Connect runtime > Member local runtimes** (on by default). The section also counts how many members use their machine and how many of them are signed in to Claude Code and to Codex, kept up to date as machines are added, removed or signed in; it never shows whose machines they are. When it is off, members cannot add a machine or start such a session (Profile says "Your workspace turned off sessions on members' machines"), and prompts in existing machine sessions get a notice.

## Several deployments on one machine

Every Docker object Spyria names carries the deployment name `SPYRIA_DEPLOYMENT`: the host container and its state volume `<deployment>-host`, runtimes `<deployment>-rt-*`, sign-ins `<deployment>-cred-*`, harnesses `<deployment>-harnesses`. Two deployments on one Docker daemon, such as a development stack and a production one, therefore never see each other's runtimes. See [Self-hosting](../guides/self-hosting.md).
