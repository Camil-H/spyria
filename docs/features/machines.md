# Machines

Agent chats run on the workspace's runtime hosts, or on a member's own machine for Claude Code and Codex subscriptions. To install the server, see [install on one machine](../guides/install.md) or the [manual install](../guides/self-hosting.md); for a local development host, [Development](../guides/development.md).

## Runtime hosts and runtimes

- A **runtime** is one container per runtime chat, from Spyria's runtime image: `spyria-agent`, Pi, node and npm, git, ripgrep and poppler-utils.
- A **runtime host** is any machine with Docker running `spyria-host`. It dials out to Spyria over a WebSocket and runs a fixed set of commands (create, start, stop, remove a runtime, report status). It needs no open port; Spyria holds no key to it. See [Decisions](../decisions/).

| | Workspace runtime host | A member's machine |
|---|---|---|
| Added by | an admin, in **Workspace settings > Runtimes** | the member, in **Profile > My machine** |
| Runs | Pi sessions of any member's runtime chats | only its owner's Claude Code and Codex sessions |
| Model calls | the prompter's API key through Spyria's gateway | the owner's subscription, directly from the machine |
| Started with | `spyria-host <claim URL>` | `spyria-host --personal <claim URL>` |

A host runs only the runtime image the server names:

- Published deployment: the `spyria-agent` image of the server's version, pulled by digest from the deployment's registry when the first runtime starts. Any other registry, name or tag is refused.
- Built from a clone: the local content ID that `bun run agent:build` wrote on the server's machine; each host must hold it.
- Until then, a prompt answers "Spyria's runtime image is not built: run bun run agent:build".

## Adding a workspace runtime host

1. In **Workspace settings**, **Runtimes**, click **Add runtime host**, name it and copy the command.
2. Run the command on the machine.
3. The row turns **Online** within seconds and the dialog closes. The host keeps its token in its state volume.

The claim code expires after 15 minutes (**Code expired**); **New command** issues a fresh one.

A host row shows CPUs, memory, runtimes against its cap, version, and badges:

- **Rootless Docker**, or **Docker runs as root** (amber: a rooted daemon has root on the host, even though containers are isolated).
- **Limits not enforced** (amber): Docker cannot apply memory and process limits there.

**Remove**, in the host's menu, disconnects it and revokes its token.

Good to know:

- The command starts `spyria-host` with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, a state volume, the Docker socket (rootless or rooted, detected) and a single-use claim URL.
- Published deployments use the host image of Spyria's version, `ghcr.io/<owner>/spyria-host:<version>`, pulled by Docker.
- When Spyria's origin is `localhost`, the command builds the host image itself and points the container at `host.docker.internal`.

## Versions and updates

Hosts report release and protocol versions on connect; `spyria-agent` reports its own to the server's readiness check. The server keeps a minimum protocol for each, raised by a breaking change or a security fix.

- **Update needed**: the host is below the minimum (no version counts as protocol 0). It is refused with "This host is out of date: update it with `<command>`", logs it and stops.
- **Update available**: accepted, but older than Spyria.
- Either badge opens the update command: it replaces the host container with the current image and keeps the state volume, so token and sign-ins survive and no new code is needed.
- A runtime whose `spyria-agent` is below the minimum fails as outdated; the next prompt places a new runtime on the current image.
- A stopped runtime on an old image is recreated on the current one when it starts again, keeping its workspace and home volumes. A running runtime keeps its image until it stops.

The same applies to a member's machine, on their profile page.

## Removing a host

Removing a host (or a member's machine) disconnects it:

- `spyria-host` logs "This host was removed", turns off its restart policy so Docker does not restart it, and stops.
- Its runtimes show **Could not start**.
- Nothing is deleted: the stopped host container, runtime containers and volumes stay.

To clean up the containers and volumes: [operations](../guides/operations.md#removing-a-runtime-host).

## Where a chat runs

A runtime goes to the least loaded online workspace host with room.

- Cap: one runtime per GiB of memory above the first 2 GiB.
- Runtimes kept ready for a repository ([Dev mode](./dev-mode.md#runtimes-kept-ready)) count against it, but never take a host's last place.
- No host online: "No runtime host is available". Chosen host offline: "The runtime host is offline".
- A host missing three heartbeats shows offline, even if its connection did not visibly close, until it reconnects.

Good to know: when the host runs directly on a memory-limited container together with its Docker (LXC, sysbox, Docker-in-Docker pod), that container's `memory.max` is the host's memory and its free memory what is left under it. A limit on the host's own container does not count: runtimes run beside it, not inside it.

### Runtime status

Statuses: **Not started**, **Starting…**, **Installing** *tool*…, **Ready**, **Sleeping**, **Host offline**, **Could not start**.

- Idle one hour, host online: stopped (**Sleeping**). The next prompt restarts it, files intact; meanwhile the panel shows the last snapshot of its files.
- Host offline during start: **Host offline**; it starts there again, files intact, when the host returns.
- Container removed (for example by hand with Docker) or stopped outside Spyria: **Sleeping** once Spyria next reaches it; the next prompt recreates or starts it.
- Stopped or failed for 7 days: removed.

Good to know:

- A runtime its connected host could not stop shows **Sleeping**; one it could not remove fails and is retried 7 days later. With the host offline, both wait for it.
- On connect, a host removes runtimes Spyria no longer knows (such as one replaced while it was offline), with their volumes.
- A package cache goes with the last runtime on its host that uses it.
- A repository's snapshot stays while the repository keeps runtimes ready; the host keeps only the newest.

### Restarting or stopping a runtime

When **Ready**, the chat's owner and Editors can open the status as a menu:

- **Restart session**: keeps the runtime, starts a fresh agent process and reloads the conversation. Use it when the agent stops answering.
  - The chip reads **Restarting…**, then **Session restarted** for a few seconds, or **New session on your next message** if no session was running or the restart failed.
  - If a later prompt has started, the restart waits for it to end.
- **Stop runtime**: puts it to sleep like the idle stop; the next prompt starts it.

Both ask for confirmation while the agent works, since they stop the turn. Other participants see the status without the menu; the server refuses them both actions.

When a Claude Code or Codex process dies, `spyria-agent` restarts it and reloads the conversation:

- A prompt that failed before any output is resent once.
- Otherwise: "The agent restarted; send your message again", with the agent's last line.
- If that line asks to run a command (impossible in a runtime), the chat says "If it happens again, restart the session" instead.
- That output is redacted like all agent output and kept in the agent's logs.

### Runtime resources

- Three volumes: workspace, home, temporary directory.
- Dev chats also get the owner's package cache shared across their runtimes on the repository (`<deployment>-cache-*`) and, read-only, the repository's newest snapshot on that host (`<deployment>-snapshot-*`).
- 2 GiB memory, 2 CPUs, 512 processes.
- Non-root user, all capabilities dropped, read-only root filesystem.

## Isolation and egress

- Each runtime has its own Docker bridge network; the host joins it to relay model and tool calls to Spyria.
- Runtimes on a host cannot reach each other where Docker isolates networks (Docker Engine on Linux; some desktop Docker products do not).
- Spyria runs model calls in the gateway on the prompting member's key. A runtime holds only a per-runtime token: never a member's key or a GitHub token. See [Security](../architecture/security.md).
- Outbound traffic is not filtered. On a cloud host, block the metadata endpoint (`169.254.169.254`) and private ranges in the provider's firewall.

## Many runtimes on one host

Each running runtime gets its own Docker bridge network, so runtimes cannot reach each other where Docker's isolation applies (Docker Engine on Linux). Default address pools allow about 30 networks per daemon.

For more than about 25 runtimes at once, set smaller pools in `/etc/docker/daemon.json` (4,096 networks) and restart Docker:

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 28 }] }
```

## Behind an outbound proxy

- Set `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` origin) and `NO_PROXY` in the shell before running the host command; it passes them on.
- Only the connection to Spyria uses the proxy: not relayed runtime calls, not the host's health check. Runtimes get no proxy settings.

## Relay limits

- HTTP bodies between server and runtime: up to 256 MiB, relayed in 256 KiB base64 chunks.
- A runtime's event stream: 1 MiB sent ahead of acknowledgements; the host closes that stream if it holds more than 8 MiB.
- A host too old for this relay is refused, with the command that updates it.

## A member's own machine

Run Claude Code on your Claude subscription, or Codex on your ChatGPT plan, on your computer. The sign-in never leaves it.

**Never run it on a machine others use.** The agent runs as you and can read your Claude and ChatGPT sign-ins.

1. In **Profile**, **My machine**, click **Set up** on the Claude Code or Codex row (or **Add my machine**). Run the command on your computer. It ends with `spyria-host --personal <claim URL>`, then the tool's sign-in command.
2. Sign in once, in a terminal:
   - Claude Code: `docker exec -it spyria-host spyria-host login claude-code`, open the URL, sign in and paste the code.
   - Codex: `docker exec -it spyria-host spyria-host login codex`, open the URL and enter the one-time code. ChatGPT may ask you to enable device code sign-in in its **Security** settings first.
3. The row reads **Signed in**. In a new runtime chat, set **Runs on** to **Local · Claude Code** or **Local · Codex**.

When the machine shows **Offline** (Docker was not running at startup, or the container stopped):

- **Start** shows `docker start spyria-host`; it reconnects within seconds and the dialog closes by itself.
- Still offline: **Set up again** gives a fresh install command. The old connection stops working; sign-ins are kept.

Good to know:

- The sign-in waits for `spyria-host --personal` to connect once ("Waiting for spyria-host to connect to Spyria…"), since Spyria names the image to sign in with. After 15 minutes without it, it stops and points to `docker logs spyria-host`.
- The container is `<deployment>-host` (`spyria-host` for the default deployment); the commands Spyria shows always use the right name.

### Sign-ins

- Each lives in its own volume on your machine (`<deployment>-cred-claude-code`, `<deployment>-cred-codex`) and survives runtime removal.
- `spyria-host logout claude-code` or `spyria-host logout codex` (via `docker exec -it`) deletes it.
- Codex logout is local only; to end the OpenAI session, log out of all devices in ChatGPT's **Security** settings.
- Expired: "Authentication required — sign in to *tool* again".
- Tokens in the agent's output (such as a printed credentials file) become `[redacted]` before events leave your machine.

### Harness install on first use

- Claude Code, Codex and their adapters are not in the runtime image; their versions are pinned in `apps/host/src/harnesses.json`.
- `spyria-host` installs the pinned set when first needed, at `login` or session start (**Installing Claude Code…**).
- It goes into the `<deployment>-harnesses` volume, one folder per pinned set, mounted read-only into sessions.
- `SPYRIA_HARNESS_REGISTRY` sets another npm registry.

### What a machine session does and does not do

- Only the owner prompts; others read. Questions and steps work as in [Agents](./agents.md).
- A message sent mid-turn joins the running turn, as on Pi: Claude Code at once, Codex at its next step (see [Agents](./agents.md#agent-chats)). While the machine is offline or signed out, it waits and starts the next turn.
- Models come from your plan, chosen in the session chip; Spyria does not route, meter or budget them.
- Agent tools (MCP) still go through Spyria's gateway, as the chat owner.
- Machine offline: prompts wait with "Your machine is offline".
- Machine without internet: Codex waits about 20 to 30 seconds (fetching its model list and ChatGPT workspace) and the turn fails, since Codex needs ChatGPT.

## Turning members' machines off

The switch **Members can run sessions on their own machine** is in **Workspace settings > Runtimes > Member local runtimes** (on by default).

- The section counts members using their machine and those signed in to Claude Code and to Codex, live, never naming them.
- Off: members cannot add a machine or start such a session (Profile says "Your workspace turned off sessions on members' machines"); prompts in existing machine sessions get a notice.

## Several deployments on one machine

Each deployment's Docker objects carry its name, so two deployments on one daemon never see each other's runtimes ([operations](../guides/operations.md#several-deployments-on-one-machine)).
