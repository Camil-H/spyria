# 0030. Tools come from a per-workspace catalogue, signed in to by each member or through one shared login

## Context

Tool servers (MCP) reached members two ways. An operator set up a server once for the whole deployment with a command-line tool, and each member signed in to it with their own account ("My connections"). Separately, an Admin of a workspace registered servers for that workspace, with no login or with one secret header that every member shared ("Shared with me"). A workspace could not choose the servers its members sign in to, an operator's server showed in every workspace of the deployment, and members met the same tools in two lists with two sets of rules.

## Decision

- Each workspace has one **catalogue** of approved tool servers, which members with `tools.manage` keep in **Workspace settings** > **Tools**. Each server has a name (unique in the workspace), an address and a sign-in mode chosen when it is added:
  - **Each member signs in** (the default): each member connects their own account, and the gateway keeps their token against their key for that workspace. The Admin who adds the server signs in once, and the gateway uses that sign-in only to list the server's tools. Its address is fixed once added: members' sign-ins belong to it.
  - **One shared login**: an Admin-entered secret header that every member's calls use, only for servers without their own sign-in, such as API-key or internal servers.
- Allowed tools and per-member restrictions apply to both modes, and each member's gateway key is granted exactly the catalogue's servers minus their restrictions.
- Members see, in **Profile** > **Tool connections**, one list of the catalogue servers they may use, and click **Connect** on those they sign in to. Members cannot add servers of their own for now.
- The deployment-wide servers and the operator command that set them up are removed, with the sign-ins members had made to them.
- On a guest's prompt, a server the owner signed in to with their own account stays refused, as the owner's personal connections were ([decision 0009](0009-agent-acts-as-the-owner.md)); a shared-login server follows the intersection of the owner's and the guest's tools.

## Consequences

- One place decides which tools a workspace uses, and tools of one workspace never show in another.
- A server members sign in to must let the gateway register itself (OAuth dynamic client registration), since the catalogue takes no OAuth client of its own; a server that needs a pre-registered OAuth app, such as GitHub's MCP server, cannot be added until it does.
- Moving a member sign-in server to another address means removing it and adding it again, and members connect again.
