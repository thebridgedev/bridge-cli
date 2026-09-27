/*
 * TBP-709 (D) — what `bridge … list` shows, minus the platform's internals.
 *
 * The REST DTOs these come from also serve the dashboards and the SDKs, so
 * they are left alone; the trimming happens at the presentation layer.
 * Port of bridge-api's MCP `shape.ts` (same functions, same tests) so the
 * CLI lists and the MCP lists cannot drift. Every function is pure and leaves
 * its input untouched.
 */

/**
 * Tenant metadata keys the platform writes for its own conversion-pixel
 * bookkeeping (tracking.service.ts, tenant.service.ts). Never app data.
 */
export const INTERNAL_TENANT_METADATA_KEYS = ['pendingPixelEvents', 'conversionTracking'];

/** A tenant without the platform's pixel bookkeeping in `metadata`. */
export function shapeTenant<T>(tenant: T): T {
  if (!tenant || typeof tenant !== 'object') return tenant;
  const metadata = (tenant as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return tenant;
  const kept = Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(
      ([k]) => !INTERNAL_TENANT_METADATA_KEYS.includes(k),
    ),
  );
  return { ...tenant, metadata: kept } as T;
}

/**
 * A plan without the payment provider's ids: each quota's `providerRefs`
 * (Stripe price and meter ids) is dropped. Prices and quotas otherwise stay
 * whole — `create_plan` and friends still return the full plan.
 */
export function shapePlan<T>(plan: T): T {
  if (!plan || typeof plan !== 'object') return plan;
  const quotas = (plan as { quotas?: unknown }).quotas;
  if (!Array.isArray(quotas)) return plan;
  return {
    ...plan,
    quotas: quotas.map((q) => {
      if (!q || typeof q !== 'object') return q;
      const { providerRefs: _drop, ...rest } = q as Record<string, unknown>;
      return rest;
    }),
  } as T;
}

interface PrivilegeLike {
  key?: string;
  description?: string;
}

/**
 * Roles with each privilege named once. Every role used to carry the full
 * privilege object (id, key, description) for every privilege it grants, so a
 * five-role app repeated the same descriptions five times. Now each role lists
 * privilege KEYS — what code and create_role/update_role take — and the
 * descriptions appear once, in `privileges`.
 */
export function shapeRoleList(roles: unknown[]): {
  roles: Array<Record<string, unknown>>;
  privileges: Record<string, string>;
} {
  const privileges: Record<string, string> = {};
  const shaped = (roles ?? []).map((role) => {
    const r = (role ?? {}) as Record<string, unknown>;
    const granted = Array.isArray(r.privileges) ? (r.privileges as Array<PrivilegeLike | string>) : [];
    const keys: string[] = [];
    for (const p of granted) {
      if (typeof p === 'string') {
        keys.push(p);
        continue;
      }
      if (!p || typeof p.key !== 'string') continue;
      keys.push(p.key);
      if (!(p.key in privileges)) privileges[p.key] = p.description ?? '';
    }
    return { ...r, privileges: keys };
  });
  return { roles: shaped, privileges };
}
