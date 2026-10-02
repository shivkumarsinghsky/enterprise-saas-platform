# Operations: Deployment, Scaling, Backup and Disaster Recovery

## Deployment

| Component | Scaling | Notes |
|---|---|---|
| `saas-api` (`ROLES=api`) | Horizontal, stateless | Behind a load balancer; readiness = DB + Redis |
| `saas-worker` (`ROLES=worker`) | Horizontal | `FOR UPDATE SKIP LOCKED` makes replicas safe |
| `migrate` job | One-shot per release | Runs as schema owner; advisory lock prevents concurrent runs |
| PostgreSQL | Primary + replicas per cluster | Pooled cluster also hosts the control plane |
| Redis | Primary + replica | Loss degrades rate limiting/metering only (fail open) |

Releases: run the migration job first (migrations are additive/backward compatible), then roll the API and
worker. Configuration is environment-only; secrets (`PLATFORM_API_KEY`, `JWT_PRIVATE_KEY`, DB passwords) come
from a secret manager in real deployments.

## Scaling

- **API:** stateless; tenant context, entitlements and permissions are cached in-process for 30 s.
- **Noisy neighbours:** per-tenant request limits from the plan (`api-rate-limit`); per-tenant advisory locks
  serialise only that tenant's user creation.
- **Database:** pooled clusters sized by tenant count; read replicas for reporting; large tenants moved to
  dedicated clusters by placement. Indexes lead with `tenant_id` where queries filter by it
  (e.g. `audit_events (tenant_id, occurred_at)`).
- **Outbox dispatcher:** iterates tenants per placement — fine for thousands of tenants; beyond that, move to
  change data capture or a broker relay.

## Backup strategy

| Data | Mechanism | RPO |
|---|---|---|
| PostgreSQL (each cluster) | Continuous WAL archiving + daily base backups (e.g. pgBackRest / managed PITR) | ≤ 5 min |
| Control plane | Same as pooled cluster (it lives there) | ≤ 5 min |
| Redis | Not backed up: rate-limit windows are ephemeral; usage counters are approximate and can be re-derived from logs | n/a |
| Secrets / keys | Secret manager with versioning | n/a |

Backups are encrypted, copied to a second region within the same residency boundary, and **restores are tested
on a schedule** — an untested backup is not a backup.

## Restoring a single tenant (pooled)

1. Restore the pooled cluster's backup to a temporary instance at the required point in time.
2. Export the tenant's rows (`WHERE tenant_id = $1`) in FK order.
3. In the live cluster, within a transaction with `app.tenant_id` set, delete the tenant's current rows and
   import the exported rows (RLS `WITH CHECK` guarantees nothing lands in another tenant).
4. Audit the restore as a platform action.

Dedicated-placement tenants are restored by restoring their cluster.

## Disaster recovery

| Scenario | Response | RTO target |
|---|---|---|
| API instance failure | Load balancer removes it (readiness) | Seconds |
| Redis failure | Requests continue (rate limiting fails open); restore Redis | Minutes |
| PostgreSQL primary failure | Promote replica (managed failover) | < 5 min |
| Region loss | Promote warm standby in the paired region; switch DNS | < 4 h |

## Observability

- **Logs:** JSON (pino) with `reqId` = correlation id, plus `tenantId` and `userId` once authenticated.
  Secrets and passwords are redacted.
- **Metrics:** `http_request_duration_seconds{method,route,status}`, `rate_limited_requests_total`,
  `outbox_events_dispatched_total{type}` and Node.js runtime metrics. Tenant ids are **not** metric labels
  (cardinality); per-tenant usage is in Redis (`GET /tenant/usage`).
- **Health:** `/health/live` (process) and `/health/ready` (PostgreSQL + Redis).
- **Audit:** `GET /audit-events` per tenant; every write and sign-in is recorded with the correlation id.
- Suggested alerts: 5xx rate, p95 latency per route, tenants stuck in `PROVISIONING`, outbox backlog age,
  `rate_limited_requests_total` spikes.
