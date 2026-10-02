import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "../../modules/rbac/permissions.js";
import type { TenantContext } from "../../modules/tenancy/context.js";
import { type Feature, hasFeature } from "../../modules/tenancy/entitlements.js";
import { forbidden, unauthorized } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantCtx?: TenantContext;
  }
}

export function ctxOf(req: FastifyRequest): TenantContext {
  if (!req.tenantCtx) throw unauthorized();
  return req.tenantCtx;
}

/** Route guard: the caller's roles must grant the permission. */
export const requirePermission =
  (permission: Permission) => async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!ctxOf(req).permissions.has(permission))
      throw forbidden("PERMISSION_DENIED", `missing permission ${permission}`);
  };

/** Route guard: the tenant's plan (or an override) must include the feature/module. */
export const requireFeature = (feature: Feature) => async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!hasFeature(ctxOf(req).entitlements, feature)) {
    throw forbidden("FEATURE_NOT_ENTITLED", `the '${feature}' feature is not included in the tenant's plan`);
  }
};
