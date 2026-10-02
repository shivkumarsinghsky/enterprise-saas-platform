# ADR-006: TypeScript on Node.js for the Reference Implementation

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

The platform must be easy to run and read for reviewers, with strong typing for request validation and domain
models. Equivalent implementations are common in .NET (ASP.NET Core + EF Core global query filters + RLS) and Java.

## Decision

TypeScript (strict) on Node.js 22 with Fastify, `pg` (plain SQL), zod for validation, `jose` for JWTs, ioredis and
pino. No ORM: the SQL that RLS protects is visible in the code.

## Alternatives Considered

- **ASP.NET Core** — excellent fit (middleware pipeline, EF Core global query filters as an additional isolation
  layer); a natural port of this design.
- **An ORM (Prisma/TypeORM)** — less SQL, but hides the per-transaction `set_config` and makes RLS behaviour
  less obvious.

## Trade-offs

Plain SQL means more boilerplate for mapping rows.

## Consequences

The isolation-critical code paths (`withTenant`, RLS policies) are short and directly reviewable.
