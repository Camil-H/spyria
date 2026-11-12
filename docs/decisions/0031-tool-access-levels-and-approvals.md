# 0031. Tools are granted per role at a level, after an admin confirms what each tool does, and members choose their approvals

## Context

[Decision 0030](0030-workspace-tools-catalogue.md) gave each catalogue server one list of allowed tools for the workspace, narrowed per member. A workspace with many members had to set each one by hand, a new member got every allowed tool, and nothing told reading tools from writing ones but the server's own `readOnlyHint`, which a server may set wrongly or leave out. Approvals existed only for a guest's write call on a shared-login server, always asked, and could not be turned off or extended to the owner's own calls.

## Decision

- **Access per role.** For each catalogue server, every workspace role has a level: **None**, **Read** (the tools marked read) or **Read and write** (all of them), plus changes for single tools that allow or refuse one tool against that level. A role without a setting has None. A member can also be named on a server with their own level and changes, which replace their role's there, both to give more and to give less. A member's gateway key is granted exactly the tools their access gives on each server, and a member without any does not see the server in Profile. Changing a member's role grants them the new role's tools at once.
- **What each tool does is the admin's call.** Spyria reads the server's `readOnlyHint` and `destructiveHint` when it lists the tools, as a suggestion only: the admin who adds the server confirms or corrects each tool's read or write marking, and the server reaches no one until they confirm. The marking can be corrected later. Tools a new listing adds count as writing until the admin marks them otherwise.
- **Approvals are the account holder's choice.** For each tool, with a default for each server, the member whose account a call uses chooses **Never** or **Always**: the prompter on servers each member signs in to, the chat owner on shared-login servers, where **On a guest's prompt** is a third choice. Since a guest's prompt cannot use the owner's own sign-ins, that person is the chat owner in both cases, and the owner answers the approval card. Read tools default to Never, tools the server marks destructive to Always, and the other tools to the server's default: Never on servers each member signs in to, On a guest's prompt on shared-login servers, as before.
- The workspace-wide **Allowed tools** list and the per-member restrictions are removed.

## Consequences

- A workspace sets its tools once per role, and a new member gets their role's tools with no further step.
- Adding a server takes one more step (confirming what its tools do), and a server is useless until roles get a level; until then no key is granted its tools.
- Read and write mean what the admin confirmed, not what a server claims; the relay no longer asks the gateway for the hint before each call.
- An owner can make a guest's write call run without asking (Never), or make their own calls ask (Always): approvals follow the person whose account answers for the call.
- A call that waits needs the owner to answer within the approval window: on a turn nobody watches, such as a quality-gate turn, a tool set to Always, including a destructive one by default, is refused once the window ends. Owners who let such turns run set those tools to Never.
- Servers in the catalogue before this change start unreviewed, with no access: an admin confirms their tools and sets the roles' levels again.
