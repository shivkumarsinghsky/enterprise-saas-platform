# ADR-001: Modular Monolith First, With Service-Ready Boundaries

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

The target architecture has identity, tenant management, business modules, audit and notifications as separate
concerns. Splitting them into separately deployed services from day one multiplies operational cost (deployments,
network calls, distributed transactions, tracing) before there are independent teams or scaling needs.

## Decision

Build one deployable with strict module boundaries (`src/modules/*`), run in two roles from the same image
(`api`, `worker`). Cross-cutting platform concerns (tenant transactions, request pipeline, errors) live in
`src/platform`. Cross-module integration that will become asynchronous goes through the **outbox**.

## Alternatives Considered

- **Microservices from the start** — independent deployability, but every tenant-scoped operation would need
  distributed tenant-context propagation, and provisioning would become a cross-service saga immediately.
- **Unstructured monolith** — fastest initially, but boundaries erode and later extraction is expensive.

## Trade-offs

- One deployable: a defect in one module can affect the process; all modules release together.
- Module boundaries are enforced by convention and review rather than by the network.

## Consequences

- The [evolution table](../architecture.md#evolution-to-services) lists the triggers and steps for extracting
  services.
- Tenant isolation does not depend on the deployment shape: it is enforced in PostgreSQL.
