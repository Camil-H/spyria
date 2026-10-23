# Architecture standard — controls and governance

The reviewer's view. Rule text lives in the reference files and is not repeated here,
so every rule has exactly one authoritative statement:

| Group | File |
|---|---|
| `L` layering | [`references/layering.md`](references/layering.md) |
| `B` boundaries | [`references/boundaries.md`](references/boundaries.md) |
| `C` contracts and dependency injection | [`references/contracts-dependencies.md`](references/contracts-dependencies.md) |
| `V` values | [`references/values-primitives.md`](references/values-primitives.md) |
| `G` configuration and flags | [`references/config-flags.md`](references/config-flags.md) |
| `S` security | [`references/security.md`](references/security.md) |
| `TX` transactions | [`references/transactions.md`](references/transactions.md) |
| `E` errors | [`references/errors.md`](references/errors.md) |
| `RS` resilience | [`references/resilience.md`](references/resilience.md) |
| `AS` concurrency | [`references/concurrency.md`](references/concurrency.md) |
| `O` observability | [`references/observability.md`](references/observability.md) |
| `T` testing | [`references/testing.md`](references/testing.md) |
| `N` naming and typing | [`references/naming-typing.md`](references/naming-typing.md) |

Every rule appears in the gate register at
`tests/rules/GATES.md` — the mechanism that makes it true, a dormancy trigger, or the reason
review holds it; a rule with none of those is not a rule.

## Scope

Governs application and service code.

Adopt on a greenfield repository from the first commit — every contract is cheapest to enable when
there is nothing to migrate. See [Annex D](#annex-d--adoption-and-amendment) for retrofitting.

## Controls

The live register — one row per rule, grouped and toggled — is
[`tests/rules/GATES.md`](../../../tests/rules/GATES.md), maintained by whoever changes a
mechanism.

## Reference dependency contract

Enforced by the import-boundary tool named in the gate register, for every context.

- **Inward (`L1`, `L3a`, `L3b`, `L10b`):** layers are ordered `entrypoints`, then `integrations | operations | queries`, then `contracts`, then `domain`. A layer imports only layers below it, and only those the `L3a` table lists. Siblings joined by `|` do not import each other. The contract is exhaustive: a sub-package outside the list fails the check.
- **Published surface (`B2`):** a context's layers are importable only from within that context and from the composition root. A context added later is constrained without editing the rule.
- **Cycles (`L8`):** not caught by the two checks above and need a separate graph check.

## Exceptions

A rule is violated only under a recorded waiver stating the rule id, the reason, the accountable
owner, an expiry date, and the compensating control. Waivers are reviewed at expiry and are not
renewed silently. An undocumented violation of a blocking control is not a waiver — it is a build
failure.

# Annexes

## Annex A — Supply chain

Committed lockfile with hashes. An SBOM generated per artifact. Build provenance attestation and
artifact signing. Dependency vulnerability scanning with a named severity threshold and a remediation
SLA. A license allowlist. Base images pinned by digest and CI actions pinned by commit.
#TODO: record the organization's severity threshold, SLA, and license allowlist.

## Annex B — Incident, disaster recovery, and rollback

RPO and RTO per data class. Rollback compatibility windows: code at version N and N−1 both run against
schema N. Migration strategy is expand-then-contract, with a stated compatibility window between code
and schema. The incident-review loop that the `E` and `TX` controls assume.

## Annex C — CI scaling

Whole-repository checks on every change become the bottleneck that gets rules disabled. Specify
impacted-target selection, a merge queue, and a wall-clock budget for required checks. `P6` survives
only if the gates stay fast.

## Annex D — Adoption and amendment

Greenfield: enable every contract from the first commit. Retrofit: enable contract by contract, per
context, with baseline files that only ratchet tighter and gates that apply to new code first.
Amending this standard requires a recorded decision; the waiver registry's location and its approver
are named there.

# Glossary

- **Bounded context** — a top-level package owning a coherent slice of the domain, with a single
  published surface.
- **Domain** — entities, value objects, and invariants expressing business rules, independent of
  delivery technology.
- **Contract** — an interface declared by an inner layer describing a capability it requires.
- **Operation** — one application action, orchestrating domain objects through contracts within a
  single transaction boundary.
- **Query** — a read-side function returning a DTO shaped by the question asked, bypassing the domain.
- **Integration** — an implementation of a contract against a specific technology.
- **Composition root** — the module in `entrypoints/` that constructs the object graph and scope
  factories.
- **Kernel** — the shared package of value types every context may import.
- **Unit of work** — an opaque handle representing one transaction boundary, from which repositories
  are resolved.
- **Outbox** — a table written in the same transaction as a state change, relayed to other contexts or
  systems by a separate process.
