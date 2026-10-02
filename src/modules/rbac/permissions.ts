/** Permission catalogue. Permissions are `<resource>:<action>` strings checked server-side. */
export const PERMISSIONS = [
  "users:read",
  "users:write",
  "roles:read",
  "roles:write",
  "assets:read",
  "assets:write",
  "audit:read",
  "settings:read",
  "settings:write",
  "usage:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

/** Roles created for every tenant at provisioning time; they cannot be modified by tenants. */
export const SYSTEM_ROLES: Record<string, Permission[]> = {
  "tenant-admin": [...PERMISSIONS],
  "asset-manager": ["assets:read", "assets:write", "users:read"],
  viewer: ["assets:read"],
};

export function effectivePermissions(rolePermissions: string[][]): Set<Permission> {
  return new Set(rolePermissions.flat().filter(isPermission));
}
