# ADR-004: Permissions Resolved Server-Side, Not Embedded in Tokens

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Embedding roles or permissions in JWTs avoids a lookup per request, but a token stays valid until it expires:
removing a role or disabling a user would not take effect for up to the token lifetime, and tokens grow with the
number of permissions.

## Decision

Access tokens carry only identity (`sub`, `tid`). On each request the platform resolves the user's status and
effective permissions from the tenant's roles, caches them in-process for at most 30 seconds, and invalidates the
cache entry locally whenever roles or user status change.

## Alternatives Considered

- **Permissions in the token** — no lookup; stale for the token lifetime; large tokens.
- **No cache** — always fresh; one extra query per request.
- **Distributed cache with pub/sub invalidation** — fresh across instances; more infrastructure (a reasonable next
  step, listed in Future Improvements).

## Trade-offs

With several API instances, a change can take up to the cache TTL to reach the other instances.

## Consequences

Integration tests show a role change and a user disablement taking effect on the next request without re-login.
