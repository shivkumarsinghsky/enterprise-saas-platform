import { describe, expect, it } from "vitest";
import { effectivePermissions, isPermission, SYSTEM_ROLES } from "../../src/modules/rbac/permissions.js";
import { computeEntitlements, hasFeature, limitOf } from "../../src/modules/tenancy/entitlements.js";

describe("entitlements", () => {
  const plan = [
    { featureKey: "assets", limitValue: null },
    { featureKey: "max-users", limitValue: 5 },
    { featureKey: "api-rate-limit", limitValue: 60 },
  ];

  it("grants plan features and limits", () => {
    const e = computeEntitlements("starter", plan, []);
    expect(hasFeature(e, "assets")).toBe(true);
    expect(hasFeature(e, "audit-log")).toBe(false);
    expect(limitOf(e, "max-users")).toBe(5);
    expect(limitOf(e, "audit-log")).toBeUndefined();
  });

  it("applies per-tenant overrides: enable, disable and change limits", () => {
    const e = computeEntitlements("starter", plan, [
      { featureKey: "audit-log", enabled: true, limitValue: null },
      { featureKey: "assets", enabled: false, limitValue: null },
      { featureKey: "max-users", enabled: true, limitValue: 25 },
      { featureKey: "api-rate-limit", enabled: true, limitValue: null },
    ]);
    expect(hasFeature(e, "audit-log")).toBe(true);
    expect(hasFeature(e, "assets")).toBe(false);
    expect(limitOf(e, "max-users")).toBe(25);
    expect(limitOf(e, "api-rate-limit")).toBe(60); // null override keeps the plan's limit
  });
});

describe("permissions", () => {
  it("unions role permissions and ignores unknown strings", () => {
    const p = effectivePermissions([["assets:read"], ["assets:read", "assets:write", "made:up"]]);
    expect([...p].sort()).toEqual(["assets:read", "assets:write"]);
  });

  it("system roles only use catalogue permissions", () => {
    for (const perms of Object.values(SYSTEM_ROLES)) expect(perms.every(isPermission)).toBe(true);
    expect(SYSTEM_ROLES.viewer).toEqual(["assets:read"]);
  });
});
