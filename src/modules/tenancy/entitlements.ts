/**
 * Entitlements = plan features overlaid with per-tenant overrides.
 * A feature is either a module switch (limit = null) or a limit (max-users, api-rate-limit).
 */
export interface FeatureGrant {
  featureKey: string;
  limitValue: number | null;
}

export interface FeatureOverride extends FeatureGrant {
  enabled: boolean;
}

export interface Entitlements {
  plan: string;
  features: Record<string, { limit: number | null }>;
}

export const FEATURES = ["assets", "audit-log", "custom-roles", "max-users", "api-rate-limit"] as const;
export type Feature = (typeof FEATURES)[number];

export function computeEntitlements(
  plan: string,
  planFeatures: FeatureGrant[],
  overrides: FeatureOverride[],
): Entitlements {
  const features: Entitlements["features"] = {};
  for (const f of planFeatures) features[f.featureKey] = { limit: f.limitValue };
  for (const o of overrides) {
    if (!o.enabled) delete features[o.featureKey];
    else features[o.featureKey] = { limit: o.limitValue ?? features[o.featureKey]?.limit ?? null };
  }
  return { plan, features };
}

export const hasFeature = (e: Entitlements, feature: Feature) => feature in e.features;

/** `null` means unlimited; `undefined` means the feature is not granted at all. */
export const limitOf = (e: Entitlements, feature: Feature): number | null | undefined =>
  e.features[feature]?.limit;
