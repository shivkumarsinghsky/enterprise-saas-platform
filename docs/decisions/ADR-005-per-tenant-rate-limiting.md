# ADR-005: Per-Tenant Rate Limiting in Redis, Failing Open

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

In a pooled platform one tenant's burst (bulk import, misbehaving integration) consumes capacity shared with every
other tenant. Limits must differ by plan, be shared across API instances, and must not take the platform down if
the limiter itself fails.

## Decision

A fixed-window counter per tenant per minute in Redis (`t:{tenantId}:rl:{window}`), with the limit taken from the
tenant's entitlements (`api-rate-limit`). The same pipeline increments a daily usage counter for metering. If
Redis is unavailable the request is **allowed** and a warning is logged; readiness reports Redis as down.

## Alternatives Considered

- **Token bucket / sliding window (Lua script)** — smoother limits at window edges; slightly more complex. A good
  upgrade if bursts at window boundaries matter.
- **Gateway-level limiting (Nginx/Envoy)** — efficient, but plan-aware limits need tenant resolution at the gateway.
- **Fail closed** — protects the database during a Redis outage but turns a cache failure into a full outage.

## Trade-offs

Fixed windows allow up to 2× the limit across a window boundary. Failing open removes noisy-neighbour protection
while Redis is down.

## Consequences

Tests verify: per-tenant 429 with `Retry-After`, no effect on other tenants, and requests still served when Redis is
disconnected.
