# Decision records

Each record states one decision: the context that called for it, what was decided, and its consequences (and the alternatives considered, when there were real ones). A record is never rewritten to describe a different decision; a later decision that replaces it gets a new number and links back.

| # | Decision |
|---|---|
| [0001](0001-postgres-source-of-truth.md) | Postgres is the source of truth, the event store and the job queue |
| [0002](0002-zero-for-ui-websocket-for-tokens.md) | Zero syncs UI state; agent tokens stream over a WebSocket |
| [0003](0003-bounded-contexts.md) | Bounded contexts with inward-pointing layers |
| [0004](0004-members-keys-through-a-gateway.md) | Members bring their own model keys, through one gateway |
| [0005](0005-runtime-hosts-dial-out.md) | Runtime hosts dial out |
| [0006](0006-own-agent-process.md) | Spyria's own agent process, with Pi for API-key chats |
| [0007](0007-subscriptions-on-the-members-machine.md) | Subscription harnesses run on the member's own machine |
| [0008](0008-one-model-per-session.md) | One model per session, chosen at the first prompt |
| [0009](0009-agent-acts-as-the-owner.md) | The agent acts as the chat owner; guests get the intersection |
| [0010](0010-permissions-as-sets.md) | Permissions are checked; roles are stored sets of them |
| [0011](0011-publishing-through-server-side-bundles.md) | Publishing goes through server-side bundles |
| [0012](0012-per-workspace-sso.md) | Per-workspace SSO with emailed domain verification |
| [0013](0013-removed-members-chats-freeze.md) | A removed member's chats freeze and can be transferred |
| [0014](0014-hard-stop-budgets.md) | Budgets are a hard stop at the relay |
| [0015](0015-opentelemetry-and-json-logs.md) | OpenTelemetry traces and JSON logs |
| [0016](0016-deployment-name-prefix.md) | A deployment name prefixes every Docker object |
| [0017](0017-one-compose-file-one-origin.md) | One Compose file and one origin |
| [0018](0018-tests-on-their-own-stack.md) | Tests run on their own Postgres, with fakes for everything external |
| [0019](0019-business-source-license.md) | Business Source License with a member threshold |
| [0020](0020-instance-sign-in-apps.md) | One-click Google and Microsoft sign-in through the apps of the instance |
| [0021](0021-ci-on-github-actions-through-develop.md) | CI on GitHub Actions, with `main` fed from a tested `develop` |
| [0022](0022-no-screenshot-baselines.md) | No screenshot baselines; reviewers judge the looks |
| [0023](0023-gateway-keys-serve-tools-without-model-keys.md) | Every member's gateway key serves tools, with or without a model key |
| [0024](0024-typed-actors-on-events.md) | Events record a typed actor and the member it acts for |
