# Agents

This page explains what happens in a runtime chat: which agent (harness) runs, how its model is chosen, and what a member sees and controls while it works. It is for members who use agent chats and for contributors who need the rules behind them. Where a chat physically runs is in [Machines](./machines.md); sharing rules are in [Chats and sharing](./chats-and-sharing.md).

## Agent chats

A runtime chat pairs a conversation with an agent running in its own sandboxed **runtime**. The first prompt starts the runtime if needed (the header shows **Starting…**, then **Ready**), and the agent's reply streams into the chat as it is written. An idle runtime goes to sleep and wakes on the next prompt; its files stay.

Prompts are handled one turn at a time. A prompt sent while the agent works waits and runs after the current turn, in order. Before each turn the server checks again that its author may still post in the chat and, on a Spyria runtime, has an LLM key in the workspace; otherwise the prompt gets a notice such as "*Name* has no LLM key in this workspace" and the next one runs.

The agent acts as the chat owner for tools (**Agent acts as** *owner* in the header), and each model call runs on the key of the member who sent the prompt. Every model call records both.

## Harnesses

A harness is the agent program that runs the loop. Spyria does not write its own model loop: it runs existing agents inside its own runtime image, driven by `spyria-agent`.

| Harness | Where it runs | Pays for the model | Chosen by |
|---|---|---|---|
| **Pi** | a Spyria runtime on a workspace runtime host | the prompting member's API key, through the model gateway | Spyria's routing (below) |
| **Claude Code** | the owner's own machine | the owner's Claude subscription | the owner, from the tool's own model list |
| **Codex** | the owner's own machine | the owner's ChatGPT plan | the owner, from the tool's own model list |

The choice is **Runs on** in the chat: **Spyria runtime**, **Local · Claude Code** or **Local · Codex**. It is offered to the owner before the first prompt, only lists what is available (an online workspace host; a machine that is online and signed in to that tool), and is picked automatically when only one choice exists. Once the agent session has started, where it runs no longer changes; fork the chat to continue elsewhere.

Subscription harnesses run only on the member's own machine because a subscription sign-in must never reach Spyria's servers: Anthropic and OpenAI do not allow a third party to hold or relay those credentials. A session on a member's machine is owner-only: other participants read it but cannot prompt, and it is not routed, metered or budgeted by Spyria. See [Machines](./machines.md).

## Models and routing

On a Spyria runtime, the session's model is chosen once, at the first prompt, from the models the prompting member's keys can reach. A model is reachable when its provider has one of the member's keys in the gateway. The catalog in `packages/kernel/src/models.ts` assigns each model a tier (large, medium or small) and covers Anthropic, OpenAI, Mistral, Google Gemini, xAI, DeepSeek, Z.ai and OpenRouter. Prices and context windows come from the gateway's model list, refreshed every hour.

1. A classifier reads the first message and answers two questions: the tier the task needs, and the reasoning effort (high, medium or low). It runs on the member's cheapest reachable model (a dedicated decision model when the member's keys reach one), with a 3-second timeout, and is billed to the prompter like any model call.
2. Only a confident answer (at least 0.8) of `large` or `small` moves away from the default. The default is the prompter's best reachable **medium** model; when a tier has no reachable model, the nearest tier is used.
3. If the classifier fails or times out, the session falls back to the default and the decision is recorded with its reason.

The model is chosen once per session, not per turn, because switching models discards the provider's prompt cache and makes every turn reread the whole conversation.

When another participant prompts later, their keys must reach the session's model; otherwise the prompt is refused with "Your keys cannot reach *model*; switch the model or add a key". Prompts from different members use different keys, so they do not share a provider's prompt cache.

## The session chip: model, effort, subagents

The chip in the chat shows the session model and effort (before the first prompt: "Model chosen at first prompt"). A participant with `session.configure` (Owner and Editor) opens it to change:

- **Main model:** any reachable model, or one found with **Search all models** among the models the gateway lists for the member's providers. A switch asks for confirmation and shows the estimated cost of the next reply, which rereads the whole conversation with the new model. It applies at the next prompt and keeps the conversation's context.
- **Effort:** **Off**, **Minimal**, **Low**, **Medium**, **High** or **Extra high** (Pi's thinking levels).
- **Subagents:** **Auto** (each delegated task is routed on its own) or **Same as main**.

In a session on a member's machine, the owner picks the tool's own **Model** and **Effort** instead, from the lists Claude Code or Codex report.

Next to the chip, a circle shows how full the agent's context is: the tokens of its latest model call out of the model's context window, turning red from 80%, with the figures in its tooltip. It updates after every model call of the main agent, not its subagents, and shows the tokens alone when the gateway does not know the model's window. It shows only for the calls Spyria relays, so not for Claude Code or Codex on a member's subscription.

## Questions

The agent can ask the member a question with suggested answers and a free answer. A question card appears in the chat; anyone who may prompt the chat answers it, and others see it read-only. Pending questions survive a page reload. A subagent cannot ask: its questions are answered automatically with "No member is available; decide yourself and state your assumption."

On a guest's prompt, a tool call that is not read-only produces a **Tool approval** card that only the owner answers. See [Chats and sharing](./chats-and-sharing.md#prompts-from-someone-other-than-the-owner).

## Opening pages

The agent opens a page for the chat's members with `open_page`, a tool of Spyria's own tool server that Pi, Claude Code and Codex all have: a public web address, or a file of the project such as an HTML report it wrote. The server checks the address while answering the call, refuses addresses on the member's own machine or network with a reason the agent sees, and members load an opened page with a click. The page shows in the **Browser** tab of the side panel; see [Chats and sharing](./chats-and-sharing.md#browser).

## Screenshots

The agent takes a screenshot of a web page with `take_screenshot`, another tool of Spyria's tool server that Pi, Claude Code and Codex all have: typically the app it runs in the runtime, such as `http://localhost:3000`, or a public page. It picks a desktop (1280×800) or mobile (390×844) viewport, the first screen or the whole page up to 10,000 pixels tall, and a light or dark theme. The screenshot is taken inside the runtime, where the app under test listens, and saved as `.spyria/screenshots/<name>.png`, a folder kept out of git: screenshots belong in the conversation, not in commits or pull requests. The agent shows one in its reply as a Markdown image (see [Chats and sharing](./chats-and-sharing.md#projects-and-chats)). Chromium comes with the runtime image, so screenshots need no download. A page that does not load within 30 seconds, or does not answer, tells the agent why.

## Delegation and subagents

On a Spyria runtime the agent has two tools for parallel work: `delegate` hands a self-contained task to a subagent that shares the runtime's files, and `await_task` waits for a task still running. A delegated task answers within 45 seconds when it can; otherwise the agent gets a task id and collects the answer later with `await_task`.

The subagent's model is chosen in this order:

1. a model or tier the member explicitly asked for in the prompt (if their keys cannot reach it, the closest reachable one, with a note);
2. with **Same as main**, the session model;
3. with **Auto**, a classifier call on the task: a confident tier picks the strongest reachable model of that tier, otherwise the session model.

Each delegation appears as one step, "Delegated to *model* · N steps · duration", whose own steps stream live and can be expanded. In Claude Code sessions, the tool's own subagents show as task steps.

## Steps

Between messages, the agent's work shows as collapsible steps: thoughts, commands with their output, files created or edited, tool calls ("Used *tool* (*server*)"), questions and errors. When a tool needs the owner to connect or reconnect an account, the step says so with a **Connect** or **Reconnect** link. Secrets that appear in output from a member's machine are stored as `[redacted]`.

Live text streams to viewers over a WebSocket; only completed events are stored in Postgres, so a reload shows the finished steps and the turn in progress resumes streaming. See [Architecture overview](../architecture/overview.md).

## Stop

**Stop** interrupts the current turn, its running subagents and any pending tool approval, and closes the turn with "Stopped by *name*". It needs `session.configure` (Owner and Editor). Prompts waiting behind the turn run next.

## Long conversations

When a Pi session's context fills up, Pi compacts the earlier conversation into a summary. Spyria makes that summary run on the prompter's cheapest reachable model rather than the session model, because summarizing does not need the strongest model. When an agent session cannot be resumed (for example after its runtime was removed), the agent starts a new one and the chat says that it does not remember earlier messages.

## Budgets and usage, as a member sees them

Admins can set a monthly AI budget per member and a monthly total for the workspace (see [Admin](./admin.md)). As a member:

- **Profile > My usage** shows your **Monthly AI budget** with a progress bar ("$0.70 of $1.00 (70%)" or "No monthly budget") and your own spend by chat and model. You never see other members' spend there.
- At 80%, a notice above the composer of agent chats says "You have used 80% of your monthly AI budget".
- At 100%, your model calls are refused, including your subagent and routing calls: the chat shows "*Name*'s monthly AI budget is used up; an admin can raise it in Workspace settings" (or the workspace wording when the workspace total is reached). A raised or removed budget applies to the next call.

Budgets are checked against recorded spend, which is synced from the gateway every few seconds, so a member can go slightly over the limit (typically cents). Sessions on a member's own machine use their subscription and are neither metered nor stopped by budgets.

The **Usage** tab of a chat shows its spend per member.

## Keys

A member adds their LLM API keys in **Profile > LLM access**, per workspace. Keys are stored in the model gateway only; Spyria keeps a reference and the last four characters. A member without a key can read runtime chats but cannot prompt on a Spyria runtime; tools work for them all the same. Tool accounts are connected in **Profile > Connections** (**Shared with me** lists the workspace connections available to you, **My connections** your personal ones). See [Security](../architecture/security.md).
