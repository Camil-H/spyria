# 0010. Permissions are checked; roles are stored sets of them

## Context

Organizations want different shapes of access: a reader who can follow a chat, a prompter who can drive the agent but not change its settings, a finance role that sees costs and nothing else. Hard-coding role names into checks makes every new role a code change.

## Decision

- The server checks **permissions**, never role names. Chats have seven (`chat.read`, `chat.post`, `session.configure`, `tools.manage`, `members.invite`, `members.manage`, `chat.admin`); workspaces have ten (`members.invite`, `members.manage`, `roles.manage`, `sso.manage`, `github.manage`, `tools.manage`, `runtimes.manage`, `costs.view`, `budgets.manage`, `audit.view`).
- A role is a row naming a set of permissions. Built-in chat roles are Owner, Editor, Prompter and Reader; built-in workspace roles are Admin and Member. Admins can add custom roles of both kinds.
- A member can grant only a role whose permissions they hold.

## Consequences

- Custom roles need no code.
- A refusal names the missing permission, which makes it clear to the member and testable.
- Public channels grant read and post to every member without a role row.

See [security](../architecture/security.md#permissions-and-roles) and [admin](../features/admin.md).
