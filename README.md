# Enterprise SaaS Platform — Multi-Tenant Reference Architecture

[![CI](https://github.com/shivkumarsinghsky/enterprise-saas-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/shivkumarsinghsky/enterprise-saas-platform/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20RLS-336791)
![Redis](https://img.shields.io/badge/Redis-7-dc382d)
![License](https://img.shields.io/badge/license-MIT-green)

A **multi-tenant SaaS** reference architecture and implementation by **Shiv Kumar**, built in TypeScript/Node.js
on PostgreSQL and Redis. It covers the platform capabilities every B2B SaaS product needs before its first
business feature:

- tenant provisioning and **tenant isolation enforced by PostgreSQL row-level security**;
- **tenant-aware authentication** and **RBAC** with custom roles;
- **plans, entitlements and per-tenant overrides** (feature and module management);
- **per-tenant rate limiting** and usage metering;
- an **append-only audit log**;
- a **placement** mechanism that moves a tenant to a dedicated database without code changes.

All of it is covered by integration tests that attack isolation directly at the database.

> Portfolio / reference implementation. It demonstrates architecture and engineering patterns; it is not a
> hosted product.

## Architecture

```mermaid
flowchart TB
    Client["Tenant users / integrations"] --> Pipeline
    Operator["Platform operator"] -->|"X-Platform-Api-Key"| Platform["/platform/* API<br/>provisioning, plans, overrides"]
    subgraph API["saas-api (Fastify)"]
        Pipeline["Request pipeline<br/>JWT, tenant context,<br/>rate limit, correlation id"] --> Guards["Guards<br/>permission + feature"]
        Guards --> Mods["Modules<br/>identity, users, roles,<br/>assets, audit, settings"]
        Platform
    end
    Pipeline --> Redis[("Redis<br/>rate limits, usage")]
    Mods -->|"withTenant: SET LOCAL app.tenant_id"| Router{"TenantRouter<br/>by placement"}
    Platform --> Router
    Router --> Pooled[("PostgreSQL pooled cluster<br/>control plane + RLS")]
    Router --> Dedicated[("PostgreSQL dedicated cluster<br/>same schema + RLS")]
    Worker["saas-worker<br/>outbox dispatcher"] --> Router
```

Detailed views — request sequence, isolation layers, provisioning state machine, data model, evolution to
services — are in [docs/architecture.md](docs/architecture.md).

## Key Capabilities

| Capability | Implementation |
|---|---|
| Tenant management | `POST /platform/tenants` provisions a tenant (`PROVISIONING → ACTIVE`), system roles, first admin, audit record and welcome event; suspend/reactivate; plan changes |
| Tenant isolation | RLS (`USING` + `WITH CHECK`, `FORCE`) on every tenant table; transaction-local `app.tenant_id`; non-owner app role |
| Tenancy strategies | Pooled shared-schema by default; **placement** routes a tenant to a dedicated cluster ([tenancy models](docs/tenancy-models.md)) |
| Identity | Tenant-aware sign-in (tenant + email + password), scrypt hashing, RS256 access tokens, lockout after repeated failures |
| Authorization | Permission catalogue, system + custom roles, route guards, last-admin protection |
| Entitlements | Plans → features/limits, per-tenant overrides; module gating (`assets`, `audit-log`, `custom-roles`) and limits (`max-users`, `api-rate-limit`) |
| Configuration | Validated per-tenant settings (timezone, locale, branding) |
| Audit logging | Written in the same transaction as each change; append-only at the database-grant level; correlation ids |
| Notifications | Transactional outbox + dispatcher (welcome and invitation notifications) |
| Billing concepts | Plans, subscriptions per tenant, usage metering per day |
| Observability | Structured logs with tenant/user/correlation ids, Prometheus metrics with bounded labels, liveness/readiness |

## Architecture Overview

**Components and responsibilities.** One deployable with strict module boundaries
([ADR-001](docs/decisions/ADR-001-modular-monolith-first.md)), run as `api` and `worker` roles:

| Module | Responsibility |
|---|---|
| `platform` | Tenant routing and tenant-bound transactions, request pipeline, error model, caches, logging, metrics |
| `tenancy` | Provisioning, placement, plans → entitlements, settings, per-request tenant context |
| `identity` | Sign-in, token issuing/verification, brute-force protection |
| `rbac` / `users` | Roles, permissions, user lifecycle, plan user limits |
| `assets` | Example business module — an EAM-style asset register with no tenant logic of its own |
| `audit` | Append-only audit trail and query API |
| `usage` | Redis rate limiter and usage metering |
| `notifications` | Outbox and dispatcher |

**Request flow.** `JWT verify → TenantContext (tenant ACTIVE, entitlements, user permissions) → per-tenant rate
limit → route guards → handler → withTenant() transaction → RLS-filtered SQL`.

**Communication.** Synchronous HTTP for the API; asynchronous side effects through the transactional outbox,
processed by the worker. Extracting a module into a service means publishing the outbox to a broker
(as in [event-driven-platform](https://github.com/shivkumarsinghsky/event-driven-platform)).

**Failure handling.** Provisioning failures leave the tenant in `PROVISIONING` (sign-in blocked, visible to
operators). Redis outages degrade rate limiting (fail open) instead of failing requests. Every write is
transactional with its audit record. The worker uses `SKIP LOCKED`, so replicas never double-process.

## Multi-Tenancy Strategies

| Strategy | Isolation | Cost | Operations | Used here |
|---|---|---|---|---|
| Shared database, shared schema | Logical (RLS) | Lowest | One migration path | **Default (`pooled`)** |
| Shared database, separate schema | Logical, smaller blast radius | Low–medium | Migrations × tenants | Discussed |
| Database per tenant | Physical | Highest | Fleet management | **Via placement** (dedicated cluster) |

Full trade-off analysis, tenant move runbook and reasoning: [docs/tenancy-models.md](docs/tenancy-models.md) and
[ADR-002](docs/decisions/ADR-002-pooled-rls-with-placement.md).

## Technology Stack

| Area | Choice |
|---|---|
| Language / runtime | TypeScript 5 (strict), Node.js 22 |
| HTTP | Fastify 5 |
| Database | PostgreSQL 16 — row-level security, plain SQL via `pg` |
| Cache / rate limiting | Redis 7 via ioredis |
| Auth | `jose` (RS256 JWT), Node.js `scrypt` |
| Validation | zod |
| Observability | pino, prom-client |
| Tests | Vitest — unit + integration against real PostgreSQL and Redis |
| Packaging | Docker multi-stage image, Docker Compose |

## Repository Structure

```text
enterprise-saas-platform/
├── src/
│   ├── main.ts                    # composition root: config, pools, Redis, tokens, app, worker
│   ├── config.ts                  # validated environment configuration
│   ├── platform/                  # db (TenantRouter, withTenant), http pipeline + guards, cache, errors, metrics
│   └── modules/
│       ├── tenancy/               # provisioning, entitlements, context loader, platform + tenant routes
│       ├── identity/              # sign-in, tokens
│       ├── rbac/  users/          # roles, permissions, users
│       ├── assets/                # example business module
│       ├── audit/  usage/  notifications/
├── migrations/                    # schema, RLS policies, grants, seed plans
├── scripts/migrate.ts             # creates the app role, applies migrations to every cluster
├── tests/unit/                    # entitlements, permissions, tokens, passwords, cache, config
├── tests/integration/             # isolation, RBAC, plans, rate limits, audit, placement, outages
├── docker/Dockerfile, docker-compose.yml
└── docs/                          # architecture, tenancy models, operations (DR/backup), API, ADRs
```

## Getting Started

### Docker

```bash
git clone https://github.com/shivkumarsinghsky/enterprise-saas-platform.git
cd enterprise-saas-platform
docker compose up -d --build     # postgres, redis, migrate (one-shot), api, worker
```

### Local Node.js

```bash
npm ci
cp .env.example .env
docker compose up -d postgres redis
npm run migrate
npm run dev                      # http://localhost:3000
```

### Try it

```bash
# 1. Provision a tenant (platform operator)
curl -s -X POST localhost:3000/platform/tenants \
  -H 'content-type: application/json' -H 'x-platform-api-key: local-dev-platform-key-change-me-0000' \
  -d '{"slug":"acme","name":"Acme Corp","plan":"professional","region":"eu-west",
       "admin":{"email":"admin@acme.example","displayName":"Acme Admin","password":"change-me-please-123"}}'

# 2. Sign in as the tenant admin
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"tenant":"acme","email":"admin@acme.example","password":"change-me-please-123"}' | jq -r .accessToken)

# 3. Use tenant-scoped APIs — no tenant id anywhere in the URL
curl -s localhost:3000/me -H "authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/assets -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tag":"PUMP-101","name":"Boiler feed pump","location":"Plant 1"}'
curl -s localhost:3000/audit-events -H "authorization: Bearer $TOKEN"
```

## Configuration

Environment variables are validated at startup ([`src/config.ts`](src/config.ts)); see
[`.env.example`](.env.example).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled cluster as the RLS-restricted `saas_app` role |
| `DEDICATED_DATABASES` | JSON map `placement → URL` for dedicated clusters |
| `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD` | Migration job: owner connection and the password to set for `saas_app` |
| `REDIS_URL` | Rate limiting, usage metering, sign-in lockout |
| `PLATFORM_API_KEY` | Operator credential for `/platform/*` (≥ 24 chars; from a secret manager) |
| `JWT_PRIVATE_KEY` | RS256 PKCS#8 key; if empty an **ephemeral** key is generated (development only) |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SECONDS` | Token settings |
| `ROLES` | `api`, `worker` or both |

No secrets are committed. `.env.example` and `docker-compose.yml` contain local development values only.

## API Examples

```http
POST /auth/login
{ "tenant": "acme", "email": "admin@acme.example", "password": "change-me-please-123" }
→ 200 { "accessToken": "eyJ...", "expiresIn": 900, "tokenType": "Bearer" }

GET /me                                   → user, tenant, permissions, features
POST /users   { "email": "...", "displayName": "...", "password": "...", "roles": ["viewer"] }
PUT  /users/{id}/roles  { "roles": ["asset-manager"] }
POST /roles   { "name": "planner", "permissions": ["assets:read", "assets:write"] }   # needs custom-roles
GET  /assets?status=IN_SERVICE&limit=25&cursor=...
GET  /audit-events?action=asset.created                                            # needs audit-log
GET  /tenant/usage
PUT  /platform/tenants/{id}/features/audit-log  { "enabled": true }               # operator
```

Full reference with permissions, features and error codes: [docs/api.md](docs/api.md).

## Testing

```bash
npm test                 # unit tests (no infrastructure)
npm run lint && npm run typecheck

# integration tests: PostgreSQL superuser URL (creates test databases + app role) and a Redis DB
docker compose up -d postgres redis
TEST_ADMIN_DATABASE_URL=postgres://saas_owner:owner-local-dev@localhost:5432/postgres \
TEST_REDIS_URL=redis://localhost:6379/15 \
npm run test:integration
```

The integration suite (26 tests) provisions three tenants — professional, starter, and enterprise on a
**dedicated** database — and verifies:

- the same email is a separate identity per tenant; bad credentials and unknown tenants get the same 401;
- tenants see only their own assets, even though the SQL has no tenant filter; another tenant's id returns 404;
- **RLS directly:** the app role sees zero rows without a tenant context and cannot insert rows for another tenant;
- the audit log cannot be updated or deleted by the app role;
- a dedicated-placement tenant's rows exist only on the dedicated cluster;
- permission enforcement, immediate effect of role changes and user disablement, last-admin protection;
- plan gating (custom roles, audit log), overrides, the 5-user starter limit, per-tenant 429 with `Retry-After`;
- audit records with correlation ids, strict settings validation, outbox → notifications on both clusters;
- suspension, sign-in lockout, bounded metric labels, and serving requests while Redis is down.

## Docker

`docker/Dockerfile` builds a multi-stage, non-root image used for the API, the worker and the migration job.
`docker-compose.yml` runs PostgreSQL, Redis, the one-shot `migrate` service, then `api` (`ROLES=api`) and `worker`
(`ROLES=worker`) with health checks on `/health/ready`.

## Architecture Decisions

| ADR | Decision |
|---|---|
| [ADR-001](docs/decisions/ADR-001-modular-monolith-first.md) | Modular monolith first, service-ready boundaries |
| [ADR-002](docs/decisions/ADR-002-pooled-rls-with-placement.md) | Pooled tenancy with RLS + placement table |
| [ADR-003](docs/decisions/ADR-003-tenant-context-from-token-only.md) | Tenant context only from the verified token |
| [ADR-004](docs/decisions/ADR-004-permissions-resolved-server-side.md) | Permissions resolved server-side |
| [ADR-005](docs/decisions/ADR-005-per-tenant-rate-limiting.md) | Per-tenant rate limiting, fail open |
| [ADR-006](docs/decisions/ADR-006-typescript-node-stack.md) | TypeScript/Node.js stack |

## Scalability Considerations

- **Horizontal scaling:** stateless API and worker; per-request context cached in-process (30 s TTL).
- **Noisy neighbours:** plan-based per-tenant rate limits; per-tenant advisory locks for limit checks.
- **Database scaling:** pooled clusters + read replicas; large tenants moved to dedicated clusters by placement;
  `tenant_id`-leading indexes.
- **Asynchronous processing:** notifications and integrations through the outbox, off the request path.
- **Caching:** tenant record, entitlements and permissions with tenant-prefixed keys.

## Reliability

Transactional writes with their audit records; transactional outbox; `SKIP LOCKED` workers; provisioning state
machine with a visible failure state; rate limiting fails open; graceful shutdown; readiness distinguishes DB and
Redis health. Backup, per-tenant restore and DR targets: [docs/operations.md](docs/operations.md).

## Security

- **Tenant isolation** in five layers — identity, token-derived context, tenant-bound transactions, PostgreSQL RLS,
  tenant-prefixed cache keys ([architecture](docs/architecture.md#tenant-isolation-defence-in-depth)).
- **Authentication:** RS256 tokens verified for signature, issuer, audience and expiry; scrypt password hashing;
  constant-time comparisons; generic errors and equalised timing on sign-in; lockout after repeated failures.
- **Authorization:** server-side permission checks per route plus plan entitlements; last-admin protection.
- **Least privilege:** the app's database role is not the owner, has no `BYPASSRLS`, and cannot modify the audit log.
- **Input validation:** zod schemas for every body and query; strict settings schema; 1 MB body limit.
- **Secrets:** environment-only; operator key ≥ 24 chars; logs redact authorization headers and passwords.
- **Dependency security:** CI runs `npm audit` and CodeQL.

## Observability

Structured JSON logs (`reqId` = correlation id, `tenantId`, `userId`); `X-Correlation-Id` echoed on every response
and stored with audit events; Prometheus metrics (`http_request_duration_seconds{method,route,status}`,
`rate_limited_requests_total`, `outbox_events_dispatched_total`) with **no tenant ids as labels**; per-tenant usage
via `/tenant/usage`; `/health/live` and `/health/ready`.

## Future Improvements

Not implemented yet:

- Enterprise SSO per tenant (OIDC/SAML) and SCIM provisioning; refresh tokens and token revocation.
- Cross-instance cache invalidation via Redis pub/sub.
- Automated tenant move between placements and per-tenant restore tooling.
- Per-tenant encryption keys (envelope encryption) for sensitive columns.
- Billing provider integration and invoice generation from metered usage.
- OpenTelemetry tracing; an API gateway in front of extracted services.

## Related Projects

- [System Design Architecture](https://github.com/shivkumarsinghsky/system-design-architecture) — the [multi-tenant SaaS design](https://github.com/shivkumarsinghsky/system-design-architecture/blob/main/docs/designs/11-multi-tenant-saas.md) this implements
- [EAM Platform Architecture](https://github.com/shivkumarsinghsky/eam-platform-architecture) — enterprise asset management domain (the assets module)
- [Event-Driven Platform](https://github.com/shivkumarsinghsky/event-driven-platform) — outbox relay to RabbitMQ, idempotent consumers
- [Microservices Patterns](https://github.com/shivkumarsinghsky/microservices-patterns) — authentication, authorization, bulkhead, idempotency
- [Enterprise AI Agent Platform](https://github.com/shivkumarsinghsky/enterprise-ai-agent-platform) — tenant-aware AI agents with tool authorization

## Author

**Shiv Kumar** — Senior Software Engineer / Software Architect
GitHub: [github.com/shivkumarsinghsky](https://github.com/shivkumarsinghsky)

## License

[MIT](LICENSE)
