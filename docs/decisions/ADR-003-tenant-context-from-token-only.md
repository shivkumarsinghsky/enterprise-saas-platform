# ADR-003: Tenant Context Comes Only From the Verified Token

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

APIs such as `GET /tenants/{tenantId}/assets` invite insecure direct object reference bugs: a user of tenant A
changes the path to tenant B's id and the server must remember to check. Subdomain- or header-based tenant
selection has the same problem unless it is cross-checked against the credential.

## Decision

Tenant-scoped endpoints have **no tenant identifier** in the path, query or body. The tenant id comes only from the
`tid` claim of a signature-verified access token, from which the request's `TenantContext` is built. Cross-tenant
operations exist only on the separate platform-operator surface (`/platform/*`) with a different credential.

## Alternatives Considered

- **Tenant in the URL + authorization check** — explicit and cache-friendly, but every endpoint must remember the
  check.
- **Subdomain per tenant** — good UX for branding; can be added for routing/sign-in, but the token remains the
  source of truth.

## Trade-offs

A user who belongs to several tenants needs one token per tenant (switching tenants = new sign-in or token
exchange).

## Consequences

Accessing another tenant's resource by id returns `404` — indistinguishable from a missing resource — which the
integration tests verify.
