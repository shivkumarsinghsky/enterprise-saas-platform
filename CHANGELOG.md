# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-02

### Added

- Tenant provisioning with placement (pooled or dedicated cluster), suspension and plan changes.
- PostgreSQL row-level security on all tenant-scoped tables; least-privilege application role.
- Tenant-aware sign-in with RS256 tokens, lockout, and server-side permission resolution.
- RBAC with system and custom roles; plans, entitlements and per-tenant overrides.
- Per-tenant rate limiting and usage metering in Redis (fail open).
- Append-only audit log; transactional outbox with a notification dispatcher.
- Unit and integration tests (PostgreSQL + Redis), Docker image, Compose environment, CI.
- Architecture, tenancy models, operations (backup/DR), API reference and ADR-001 to ADR-006.
