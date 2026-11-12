---
name: spyria-tools
description: Use the services this workspace connected (issue trackers, documents, CRMs, monitoring…) from the shell with the spyria command. Use when a task needs data or actions from one of them.
---
# Connected services from the shell

`spyria` calls the tools of the services this workspace connected, through Spyria, as the member who prompted: the same access, approvals and audit as any tool call.

1. `spyria` lists the connected services.
2. `spyria <service>` lists the tools of one service; narrow it with `| grep -i <word>`.
3. `spyria <service> <tool> --help` shows what a tool takes.
4. `spyria <service> <tool> --<argument> <value>` runs it. Lists and objects take JSON (`--labels '["bug"]'`); `--json '{…}'` passes all arguments at once.

The answer is printed on standard output; a refusal or failure is printed on standard error with exit code 1, and says why (for example that the service is off for this chat or that the member did not approve the call). Filter long answers in the shell (`| jq`, `| head`) before reading them.
