# 0034. Catalogue tools are found when needed instead of declared on every call

## Context

Pi reached Spyria's own tools and every catalogue server through one tool server (`/mcp`), with every tool declared to the model on every call. Tool declarations are paid for on each model call and take room in the context window, and catalogue servers are large: measured from their published servers, GitHub's has 133 tools (about 35,000 tokens of declarations), Sentry's 73 (about 50,000), Notion's 24 (about 19,000), HubSpot's 21 (about 9,000) and Slack's 8 (about 800). Those five together would declare 259 tools, about 114,000 tokens, before the member says anything.

Measured by running Pi against a recording model endpoint, with GitHub's server connected, each model call declared 143 tools (38,048 tokens), and a one-tool task took 2 calls (76,096 tokens of declarations).

## Decision

- **Spyria's own tools and the catalogue are two servers.** Spyria's own tools (`open_page`, `take_screenshot`) moved to `/mcp/spyria` and stay declared, with `web_search`, delegation and the dev chat's GitHub tools. `/mcp` serves only the catalogue, for Pi, Claude Code and Codex alike.
- **Pi reaches catalogue tools only from `codemode` scripts**, on every server, with no setting: the catalogue is one line of its system prompt, and a script finds tools with `searchTools()`, calls them and keeps only what it needs from the answers. `tool_search` and declaring a server's tools were measured and dropped: code mode cost the fewest tokens on each of the five servers benchmarked against `tool_search`, and declaring tools is only cheaper on a server of a few tools. Each call in a script is still one call through the gateway, with the same access, approvals and audit; a call waiting for an approval holds the script (90 seconds tested, past Pi's default 60-second limit, since Spyria gives the catalogue server 330 seconds). The catalogue server's description must stay free of domain words: Pi adds it to the search text of every tool, so a word there stops telling tools apart ("issue tracker" pushed GitHub's `list_issues` from 5th to 26th).
- **A chat switches catalogue servers off** in its **Connected tools** tab, for members who manage the chat's tools. The server leaves them out of the agent's list (the gateway's include list) and refuses their calls, and the chat's agent lists its tools again at once.
- **The `spyria` command** in the runtime image projects the catalogue for every harness: `spyria` lists the services, `spyria <service>` their tools, `spyria <service> <tool> --help` what one takes, and running it is one call through `/mcp` with the session's token, under the same checks. Nothing about it is loaded up front: Claude Code and Codex learn it exists from one line of instructions of Spyria's tool server, and Pi from a one-line skill. Connector-specific skills are not written until a run with a real model shows a connector where the agent loses turns without them.

## Measurements

Tokens of tool declarations per model call, measured on Pi's requests with GitHub's server connected:

| Step | Declared tools | Tokens per call | Calls for a one-tool task | Declaration tokens for the task |
|---|---|---|---|---|
| Before | 143 | 38,048 | 2 | 76,096 |
| `tool_search` | 11, then 19 once loaded | 1,671, then 4,698 | 3 | 11,067 |
| Code mode (kept) | 11 | 2,156 | 2 to 3 | about 7,500 |
| Code mode, no server connected | 11 | 2,156 | 2 | 4,312 |

For a one-tool task on each server alone (declaration tokens summed over the task's calls; the turns of `tool_search` and code mode are derived from how each finds a tool, not measured with a real model):

| Server | Declared | `tool_search` | Code mode |
|---|---|---|---|
| Slack (8 tools) | 2 calls, 3,800 | 3 calls, 9,100 | 3 calls, 7,000 |
| HubSpot (21) | 2 calls, 21,100 | 3 calls, 13,700 | 3 calls, 8,000 |
| Notion (24) | 2 calls, 39,700 | 3.2 calls, 22,400 | 3 calls, 7,800 |
| GitHub (133) | 2 calls, 72,900 | 3 calls, 10,100 | 3 calls, 7,500 |
| Sentry (73) | 2 calls, 101,700 | 3.2 calls, 20,800 | 3 calls, 7,800 |

`tool_search` found the right tool in its first 8 results for 23 of 25 everyday tasks over the five servers together, when the query named the service; the two misses were naming mismatches (Sentry's `find_projects` for "list projects", Notion's `API-post-search` for "search pages") that cost a second search. The `spyria` command's discovery costs about 80 tokens to list the services, 230 for one tool's help, and 2,900 to list all of GitHub's tools (less once narrowed with `grep`).

## Consequences

- A conversation with a large server connected is about 20 times lighter per call, and several servers no longer add up on every call.
- A first use of a catalogue tool usually takes one more model call than when it was declared, and a server of a few tools (Slack: 3,800 tokens declared against 7,000 in code mode for one task) costs a little more; one way for every server was preferred to a setting.
- Every conversation pays the `codemode` tool's description (about 500 tokens more than `tool_search`'s), even with no server connected.
- `searchTools()` only finds tools whose names or descriptions share the query's words; for servers with unusual names the script can list every name of the server cheaply instead.
- Turning a server off in a chat affects every member's prompts in that chat.
- Claude Code and Codex have no code mode; the `spyria` command is their equivalent, composed in the shell.
- Claude Code searches tool servers' tools on its own (unless its base address is not Anthropic's), and Codex's current source defers every MCP tool behind its own `tool_search` on models that support it; this was read from their code, not run here.
- Claude Code and Codex sessions on a member's machine now hold the session's tools token and address in their environment, as Pi already did, so the `spyria` command works there; it is the same chat-scoped token their tool servers already used.
- A call through the `spyria` command that waits for an approval can outlast the harness's shell time limit (about two minutes in Claude Code), shorter than the five minutes an approval may take; the command then says the call may still have run, so the agent checks before running it again.
