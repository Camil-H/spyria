# 0038. AI budgets are set per role, for each day, week and month

Amends [decision 0014](0014-hard-stop-budgets.md): budgets are no longer set per member or as a workspace total.

## Context

Decision 0014 had a monthly budget per member and a monthly total for the workspace. Admins had to set each new member's budget by hand, a member could run through a month's budget in a single day, and the workspace total was a second figure that could disagree with the members' budgets.

## Decision

- **Per role, per member.** A budget belongs to a workspace role and applies to each member who holds it, for themselves: it is not shared by the role's members. Members get their role's budget, as they get its permissions and tools ([0036](0036-tool-access-per-role-only.md)).
- **Three periods.** Each role has an optional budget per day, per week (from Monday) and per month, in UTC. The relay refuses a member's call once any of their periods is used up, and the notice names that period, the longest first.
- **The workspace total is derived.** A role's total is its budget per member times its number of members, and the workspace total is the sum of the roles' totals, shown and never set. It has no limit while a role with members has none for that period.
- Spend per period is read from the model calls recorded from the gateway, by prompter and time.

## Consequences

- The per-member and workspace budgets are deleted by the migration, with their alerts.
- Changing a member's role changes their budget at once; the alerts already recorded stay until the period ends or the role's budget changes.
- Giving one member a different budget takes a custom role.
