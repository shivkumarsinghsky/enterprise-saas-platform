# ADR-002: Pooled Tenancy With Row-Level Security and a Placement Table

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Tenants range from a handful of users to large enterprises with contractual isolation requirements. A single
tenancy model either over-spends on small tenants (database per tenant) or under-delivers for regulated ones
(shared schema only). See [tenancy-models.md](../tenancy-models.md).

## Decision

- **Shared database, shared schema** with `tenant_id` on every tenant-scoped table.
- **PostgreSQL row-level security** with `USING` and `WITH CHECK` policies bound to `current_setting('app.tenant_id')`,
  `FORCE ROW LEVEL SECURITY`, and an application role that is neither owner nor `BYPASSRLS`.
- The tenant is set per transaction with `set_config('app.tenant_id', $1, true)` (transaction-local), so pooled
  connections cannot carry context between requests.
- A **placement** column routes each tenant to a cluster (`pooled` or a named dedicated cluster) through
  `TenantRouter`; dedicated clusters run the same migrations.

## Alternatives Considered

- **Database per tenant** for all — strongest isolation, high cost and fleet operations.
- **Schema per tenant** — migrations and catalogue size grow with tenant count.
- **Application-level filtering only** — a single missed `WHERE tenant_id` leaks data.

## Trade-offs

- RLS adds a predicate to every query; indexes must lead with `tenant_id` where appropriate.
- Per-tenant restore from the pooled cluster is a multi-step procedure ([operations.md](../operations.md)).
- Superusers and the owner role bypass or are subject to FORCE RLS respectively; migrations run as owner, the app
  never does.

## Consequences

- Integration tests exercise RLS directly with the app role (no context → zero rows; cross-tenant insert rejected).
- Moving a tenant between pooled and dedicated placement is an operational runbook, not a code change.
