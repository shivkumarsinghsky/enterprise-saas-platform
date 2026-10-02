# API Reference

All tenant-scoped endpoints require `Authorization: Bearer <token>`. The tenant is taken from the token — there is
no tenant id in tenant-scoped URLs. Every response carries `X-Correlation-Id` (pass your own to correlate).

Errors use one shape: `{ "error": "CODE", "message": "...", "correlationId": "..." }`.

## Platform operator (`X-Platform-Api-Key`)

| Method | Path | Description |
|---|---|---|
| POST | `/platform/tenants` | Provision a tenant with its first admin |
| GET | `/platform/tenants` | List tenants |
| PATCH | `/platform/tenants/{id}` | Change `status` (`ACTIVE`/`SUSPENDED`) or `plan` |
| PUT | `/platform/tenants/{id}/features/{feature}` | Override a feature: `{ "enabled": true, "limit": 100 }` |

```http
POST /platform/tenants
X-Platform-Api-Key: <operator key>

{ "slug": "acme", "name": "Acme Corp", "plan": "professional", "region": "eu-west",
  "placement": "pooled",
  "admin": { "email": "admin@acme.example", "displayName": "Acme Admin", "password": "change-me-please-123" } }

201 { "tenantId": "94d1...", "adminUserId": "6d47..." }
```

## Identity

```http
POST /auth/login
{ "tenant": "acme", "email": "admin@acme.example", "password": "change-me-please-123" }

200 { "accessToken": "eyJ...", "expiresIn": 900, "tokenType": "Bearer" }
```

401 for any invalid combination (no hint whether the tenant or user exists); 429 after repeated failures.

## Tenant

| Method | Path | Permission | Feature |
|---|---|---|---|
| GET | `/me` | — | — |
| GET | `/tenant/entitlements` | — | — |
| GET / PATCH | `/tenant/settings` | `settings:read` / `settings:write` | — |
| GET | `/tenant/usage` | `usage:read` | — |
| GET / POST | `/users` | `users:read` / `users:write` | `max-users` limit |
| PUT | `/users/{id}/roles` | `users:write` | — |
| PATCH | `/users/{id}` | `users:write` | — |
| GET | `/roles`, `/permissions` | `roles:read` | — |
| POST | `/roles` | `roles:write` | `custom-roles` |
| GET | `/assets?status=&limit=&cursor=` | `assets:read` | `assets` |
| GET | `/assets/{id}` | `assets:read` | `assets` |
| POST | `/assets` | `assets:write` | `assets` |
| GET | `/audit-events?action=&actor=&from=&to=&before=&limit=` | `audit:read` | `audit-log` |

## Status codes

| Code | Meaning |
|---|---|
| 400 `VALIDATION_FAILED` | Body/query failed schema validation |
| 401 `UNAUTHENTICATED` | Missing/invalid token, disabled user |
| 402 `PLAN_LIMIT_REACHED` | Plan limit (e.g. max users) |
| 403 `PERMISSION_DENIED` / `FEATURE_NOT_ENTITLED` / `TENANT_SUSPENDED` / `LAST_ADMIN` | Authorization failures |
| 404 `NOT_FOUND` | Missing — or belongs to another tenant (indistinguishable by design) |
| 409 `CONFLICT` | Duplicate slug, email, role name or asset tag |
| 429 `RATE_LIMITED` / `TOO_MANY_ATTEMPTS` | Tenant rate limit, sign-in lockout (`Retry-After`) |
