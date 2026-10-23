# 0008. One model per session, chosen at the first prompt

## Context

Prompts vary from trivial to hard. Choosing a model per turn would match each prompt, but switching models invalidates the provider's prompt cache and makes the next reply reread the whole conversation, which costs more than it saves.

## Decision

- The main model of a session is chosen once, at its first prompt (or after a lost conversation). A small classifier, run on the prompter's cheapest reachable model with a 3-second limit, reads the prompt. Only a confident "large" or "small" moves away from the prompter's best reachable medium-tier model.
- Reachable models are the catalog entries whose provider has a key of the prompter in the gateway.
- The member can switch the main model from the session chip; Spyria warns that the next reply rereads the conversation. The router never switches it on its own.
- Variation between easy and hard work goes to sub-agents: the main agent calls `delegate` with a task and an effort hint, never a model name, and the router maps it to a model the prompter's keys reach, following the chat's sub-agent policy (Auto or Same as main).
- Every routing decision is recorded with its inputs and outcome.

## Consequences

- Prompt caches stay warm for the whole session.
- Cost stays predictable; the strongest model is never the default.
- When the classifier fails or is unsure, the session runs on the medium-tier model.
- The recorded decisions allow learned routing later.

See [agents](../features/agents.md).
