import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Metric labels are bounded: route templates and status codes, never tenant or user ids (cardinality).
 * Per-tenant usage is metered in Redis instead (see TenantRateLimiter).
 */
export function createMetrics(service: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: "rate_limited_requests_total",
      help: "Requests rejected by per-tenant rate limits",
      registers: [registry],
    }),
    outboxDispatched: new Counter({
      name: "outbox_events_dispatched_total",
      help: "Outbox events processed by the dispatcher",
      labelNames: ["type"] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
