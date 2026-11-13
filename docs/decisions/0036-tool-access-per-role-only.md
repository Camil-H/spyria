# 0036. Tool access is set per role only

Amends [decision 0031](0031-tool-access-levels-and-approvals.md): a member can no longer be named on a server with their own access.

## Context

Decision 0031 let an admin name a member on a server with their own level and single tools, replacing their role's there. Each named member added a column to the server's access grid next to the roles, and a member's tools then depended on two places an admin had to keep in mind. Each role's level (None, Read, Read and write) sat above per-tool checkboxes that refused or allowed tools against it, so the same grid showed two controls for one question: which tools may this role use.

## Decision

- **Access is per role.** Every member gets exactly their role's access on each server, GitHub included. A member who needs other tools gets a role that has them.
- **One control per tool.** The access grid shows a checkbox per tool and role; each role's column heading has a checkbox that ticks or unticks every tool shown in the open tab (Read, Write or Destructive, narrowed by the search). The level stays in the stored access as the base the tool changes apply to, without its own control: GitHub's default for a role without a setting is still every tool.
- **Spyria's own tools show the same way.** The Spyria row has the same tabs, search and grid, with every box ticked and locked, since every role has them.

## Consequences

- The per-member access rows are deleted by the migration, and the members they named fall back to their role's tools.
- Giving a single member more or fewer tools takes a custom role.
