import type { Permission } from "../rbac/permissions.js";
import type { Entitlements } from "./entitlements.js";

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED";
  region: string;
  planId: string;
  placement: string;
  settings: Record<string, unknown>;
}

/**
 * Built once per request from the *verified* token, never from the URL, query or body (ADR-003).
 * Every repository call receives it, so tenant scoping is explicit at each call site and enforced again by RLS.
 */
export interface TenantContext {
  tenant: TenantRecord;
  userId: string;
  permissions: Set<Permission>;
  entitlements: Entitlements;
  correlationId: string;
}
