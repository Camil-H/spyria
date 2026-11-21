# Machines

Agent chats run on the workspace's runtime hosts, or on a member's own machine for Claude Code and Codex subscriptions. This page is for admins who add runtime hosts and for members who run sessions on their own machine. What the agent does once it runs is in [Agents](./agents.md).

## Runtime hosts and runtimes

- A **runtime** is a sandboxed container, one per runtime chat, where the agent works. It comes with Pi, Node.js and npm, git, ripgrep and tools to read PDFs.
- A **runtime host** is any machine with Docker running Spyria's host program. It connects out to Spyria and only creates, starts, stops and removes runtimes and reports their status. It needs no open port, and Spyria holds no key to the machine.

| | Workspace runtime host | A member's machine |
|---|---|---|
| Added by | an admin, in **Workspace settings > Runtimes** | the member, in **Profile > My machine** |
| Runs | Pi sessions of any member's runtime chats | only its owner's Claude Code and Codex sessions |
| Model calls | the prompter's API key through Spyria's gateway | the owner's subscription, directly from the machine |
| Started with | `spyria-host <claim URL>` | `spyria-host --personal <claim URL>` |

A host runs only Spyria's own runtime image, of the same version as Spyria, and downloads it when its first runtime starts.

## Adding a workspace runtime host

1. In **Workspace settings**, **Runtimes**, click **Add runtime host**, name it and copy the command.
2. Run the command on the machine.
3. The row turns **Online** within seconds and the dialog closes. The host stays paired when it restarts.

The claim code expires after 15 minutes (**Code expired**); **New command** issues a fresh one.

A host row shows CPUs, memory, runtimes against its cap, version, and badges:

- **Rootless Docker**, or **Docker runs as root** (amber: a rooted daemon has root on the host, even though containers are isolated).
- **Limits not enforced** (amber): Docker cannot apply memory and process limits there.

**Remove**, in the host's menu, disconnects it and revokes its token.

Good to know: the command runs the host in a locked-down container, with no privileges of its own beyond access to Docker.

## Versions and updates

Hosts report their version when they connect; runtimes report theirs to the server's readiness check. Spyria keeps a minimum version for each, raised by a breaking change or a security fix.

- **Update needed**: the host is older than the minimum. Spyria refuses it, and the host stops with "This host is out of date: update it with `<command>`".
- **Update available**: accepted, but older than Spyria.
- Either badge opens the update command: it replaces the host with the current version and keeps its pairing and sign-ins, so no new code is needed.
- A runtime older than the minimum fails as outdated; the next prompt places a new runtime on the current image.
- A stopped runtime on an old image is recreated on the current one when it starts again, keeping its files. A running runtime keeps its image until it stops.

The same applies to a member's machine, on their profile page.

## Removing a host

Removing a host (or a member's machine) disconnects it:

- The host stops for good: Docker does not restart it.
- Its runtimes show **Could not start**.
- Nothing is deleted: the stopped host, its runtimes and their files stay on the machine.

To free the disk, the operator removes them ([Operations](../guides/operations.md#removing-a-runtime-host)).

## Where a chat runs

A runtime goes to the least loaded online workspace host with room.

- Cap: one runtime per GiB of memory above the first 2 GiB.
- Runtimes kept ready for a repository ([Dev mode](./dev-mode.md#runtimes-kept-ready)) count against it, but never take a host's last place.
- No host online: "No runtime host is available". Chosen host offline: "The runtime host is offline".
- A host missing three heartbeats shows offline, even if its connection did not visibly close, until it reconnects.

### Runtime status

Statuses: **Not started**, **Starting…**, **Installing** *tool*…, **Ready**, **Sleeping**, **Host offline**, **Could not start**.

- Idle one hour, host online: stopped (**Sleeping**). The next prompt restarts it, files intact; meanwhile the panel shows the last snapshot of its files.
- Host offline during start: **Host offline**; it starts there again, files intact, when the host returns.
- Runtime removed or stopped outside Spyria (for example by hand on the host): **Sleeping** once Spyria next reaches it; the next prompt recreates or starts it.
- Stopped or failed for 7 days: removed.

Good to know:

- A runtime its connected host could not stop shows **Sleeping**; one it could not remove fails and is retried 7 days later. With the host offline, both wait for it.
- When a host connects, it removes the runtimes Spyria no longer knows (such as one replaced while it was offline), with their files.
- A dev chat's package cache goes with the last runtime on its host that uses it.
- A repository's snapshot stays while the repository keeps runtimes ready; the host keeps only the newest.

### Restarting or stopping a runtime

When **Ready**, the chat's owner and Editors can open the status as a menu:

- **Restart session**: keeps the runtime, starts a fresh agent process and reloads the conversation. Use it when the agent stops answering.
  - The chip reads **Restarting…**, then **Session restarted** for a few seconds, or **New session on your next message** if no session was running or the restart failed.
  - If a later prompt has started, the restart waits for it to end.
- **Stop runtime**: puts it to sleep like the idle stop; the next prompt starts it.

Both ask for confirmation while the agent works, since they stop the turn. Other participants see the status without the menu; Spyria refuses them both actions.

When a Claude Code or Codex process dies, Spyria restarts it and reloads the conversation:

- A prompt that failed before any output is resent once.
- Otherwise: "The agent restarted; send your message again", with the agent's last line.
- If that line asks to run a command (impossible in a runtime), the chat says "If it happens again, restart the session" instead.
- That line is redacted like all agent output.

### Runtime resources

- Its own storage, kept while the runtime sleeps: the chat's workspace, a home folder and a temporary folder.
- Dev chats also get the owner's package cache, shared by their runtimes on the same repository and host. When the repository keeps runtimes ready, a dev chat starts from the repository's newest snapshot on that host, mounted read-only: the snapshot is read-only, not the chat, so no chat changes what the next ones start from ([Dev mode](./dev-mode.md#runtimes-kept-ready)).
- 2 GiB memory, 2 CPUs, 512 processes.
- A non-root user without administrative privileges; only its own folders can be written.

## Isolation and egress

- Each runtime has its own network. Runtimes on a host cannot reach each other where Docker isolates networks (Docker Engine on Linux; some desktop Docker products do not).
- Model calls run in Spyria's gateway on the prompting member's key. A runtime never holds a member's key or a GitHub token.
- Outbound traffic is not filtered: the agent reaches the internet and whatever the host's network reaches. On a cloud host, block the metadata endpoint (`169.254.169.254`) and private ranges in the provider's firewall ([Operations](../guides/operations.md#outbound-traffic)).

## Many runtimes on one host

With Docker's default settings, a host runs about 25 runtimes at once; past that, new runtimes stop starting until the operator gives Docker more networks ([Operations](../guides/operations.md#many-runtimes-on-one-host)).

## Behind an outbound proxy

A host that reaches Spyria only through an outbound proxy works: the proxy is set in the shell that runs the host command ([Operations](../guides/operations.md#behind-an-outbound-proxy)). Runtimes get no proxy settings.

## Relay limits

Anything passed in one piece between Spyria and a runtime is limited to 256 MiB. The smaller limits of each feature, such as attachments, files shown in the chat and pushes, apply first.

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

- The sign-in command waits until your machine has connected to Spyria once ("Waiting for spyria-host to connect to Spyria…"). After 15 minutes without it, it stops and tells you to read `docker logs spyria-host`.
- The container's name can differ from `spyria-host` on some Spyria installs; the commands Spyria shows always use the right one.

### Sign-ins

- Each is kept on your machine, apart from runtimes, and survives runtime removal.
- `spyria-host logout claude-code` or `spyria-host logout codex` (via `docker exec -it spyria-host`) deletes it.
- Codex logout is local only; to end the OpenAI session, log out of all devices in ChatGPT's **Security** settings.
- Expired: "Authentication required — sign in to *tool* again".
- Tokens in the agent's output (such as a printed credentials file) become `[redacted]` before events leave your machine.

### Harness install on first use

- Claude Code and Codex are not part of the runtime: your machine installs the version Spyria has tested the first time it needs one, at sign-in or when a session starts (**Installing Claude Code…**).
- Sessions use that copy unchanged; updating the host brings newer versions.

### What a machine session does and does not do

- Only the owner prompts; others read. Questions and steps work as in [Agents](./agents.md).
- A message sent mid-turn joins the running turn, as on Pi: Claude Code at once, Codex at its next step (see [Agents](./agents.md#agent-chats)). While the machine is offline or signed out, it waits and starts the next turn.
- Models come from your plan, chosen in the session chip; Spyria does not route, meter or budget them.
- The workspace's tools still go through Spyria, with the chat owner's access.
- Machine offline: prompts wait with "Your machine is offline".
- Machine without internet: Codex waits about 20 to 30 seconds (fetching its model list and ChatGPT workspace) and the turn fails, since Codex needs ChatGPT.

## Turning members' machines off

The switch **Members can run sessions on their own machine** is in **Workspace settings > Runtimes > Member local runtimes** (on by default).

- The section counts members using their machine and those signed in to Claude Code and to Codex, live, never naming them.
- Off: members cannot add a machine or start such a session (Profile says "Your workspace turned off sessions on members' machines"); prompts in existing machine sessions get a notice.

## Several deployments on one machine

Two Spyria installs, such as a trial one and a production one, can share one machine's Docker: neither sees the other's runtimes. The operator gives each its own name when installing it.
