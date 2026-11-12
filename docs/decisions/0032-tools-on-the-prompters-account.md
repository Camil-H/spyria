# 0032. The agent calls tools with the prompter's own account, and GitHub's tools are granted like the catalogue's

## Context

[Decision 0009](0009-agent-acts-as-the-owner.md) made the agent act as the chat owner: its tool calls used the owner's connections, and on a guest's prompt it could use only the shared-login servers both could use, never a server the owner signed in to with their own account. A guest who had connected that server themselves still got a refusal, and the owner answered every approval, even for a call on a guest's prompt. Model calls already ran on the prompter's key ([0004](0004-members-keys-through-a-gateway.md)), so a shared chat mixed two rules.

GitHub sat outside the tools catalogue ([0030](0030-workspace-tools-catalogue.md), [0031](0031-tool-access-levels-and-approvals.md)): pushing, opening and updating a pull request were reserved to the owner's prompts, reading tools were open to every prompt, and no admin could narrow either. The Changes panel, the pull request card and the quality gates each checked ownership on their own, and Spyria's own tools appeared nowhere an admin could see them.

## Decision

- **Tools run on the prompter's account** (amends 0009 for tools). A catalogue server each member signs in to is called with the prompter's own sign-in, as model calls use the prompter's key. A prompter who has not connected a server does not get it on their prompt: the step says so, and the **Connect** link shows to that prompter only. The agent lists the prompter's catalogue tools, and lists them again when a turn starts with another prompter; it lists every GitHub command, and the server refuses those the prompter's access lacks.
- **Shared-login servers keep 0009's rule.** They need both the owner's and the prompter's access on a guest's prompt, they use the owner's approval choices, and the owner answers their approvals.
- **Approvals go to the account holder** (amends 0031). On a server each member signs in to, the prompter's approval choices apply and the prompter answers the card, since their own access is used.
- **GitHub is a row of the Tools card** like any other server: its commands are marked read or write by Spyria, every role has a level and single tools, a member can be named with their own, and each member chooses their approvals. A role without a GitHub setting reads and writes, so dev chats keep working before an admin sets levels. Pushing and pull requests use the GitHub account of the member who prompted, or who clicked; the quality gates act for the owner. The name GitHub is reserved in the catalogue.
- **One server-side check** decides a member's GitHub commands in a chat, for the agent's tools, the Changes panel, the pull request card and the quality gates.
- **Spyria's own tools show as Built in**, with what each does and nothing to edit: their settings live with their feature (the browser, the quality gates). The **Connect GitHub** card keeps the setup: the App, its repositories and members' accounts.
- Each member is told, before their first prompt in a shared chat, that everyone in it sees what their tools return.
- Sessions on a member's own machine are unchanged: only the owner prompts there.

## Consequences

- A guest uses the servers they connected themselves, and the owner is never answerable for a call on someone else's account.
- Results of a member's tools are visible to everyone in the chat, which the warning before their first prompt says.
- A guest whose role writes to GitHub can push the owner's chat branch and open its pull request with their own account, which GitHub then shows as its author. Admins who want only owners to push give roles Read on GitHub and name the owners who write.
- A member with no GitHub account connected sees Push in the Changes panel and is asked to connect their own account when they click it.
- Listing tools per prompter costs a relisting when the prompter changes between turns.
