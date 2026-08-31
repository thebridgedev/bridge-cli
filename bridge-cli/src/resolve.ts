// TBP-586 — Address resources by their human-readable key, not just by id.
//
// Most write commands used to take an opaque `--id` only, which forced every
// caller (agent or human) to run a `list` first and pair the right id with the
// right name by hand. This module is the single place that turns a
// human-readable identifier into an id, so every noun behaves the same way.
//
// Semantics mirror the MCP layer's `toggle_feature_flag`
// (bridge-api/microservices/account/nebulr-api/mcp/tools/flags.ts): list, find
// by key, act — with two additions the CLI needs:
//
//   * exactly one of the id option / key option must be supplied, and
//   * a key that matches MORE THAN ONE resource is a hard failure that lists
//     the candidates. Never guess. Silently deleting the wrong tenant because
//     two of them share a name is the worst outcome this module can produce.

import { getManagementClient } from './config.js';

/**
 * Error carrying a stable machine-readable `code`, so `outputError` can emit
 * something better than UNKNOWN_ERROR for resolution failures.
 */
export class ResolveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

export interface ResolveSpec<T> {
  /** Capitalised singular noun used in messages, e.g. `'Flag'`. */
  noun: string;
  /** Flag the user types to address by id, e.g. `'--id'` or `'--user-id'`. */
  idOption: string;
  /** Flag the user types to address by key, e.g. `'--key'`, `'--email'`. */
  keyOption: string;
  /** What the key option holds, in prose: `'key'`, `'name'`, `'email'`. */
  keyLabel: string;
  /** Command that lists the candidates, e.g. `'bridge flag list'`. */
  listCommand: string;
  /** Fetches every candidate. Only called when resolving by key. */
  list: () => Promise<T[]>;
  idOf: (item: T) => string;
  /** The item's key; `undefined` when the item has none (skipped in matching). */
  keyOf: (item: T) => string | undefined;
  /**
   * Comparison normaliser. Defaults to identity (exact, case-sensitive).
   * Emails pass `(s) => s.toLowerCase()`.
   */
  normalize?: (value: string) => string;
  /** One-line rendering of a candidate, used in the ambiguity error. */
  describe?: (item: T) => string;
}

export interface ResolveTarget {
  id?: string;
  key?: string;
}

const CODE_SAFE = /[^A-Z0-9]+/g;

function codeFor(noun: string, suffix: string): string {
  return `${noun.toUpperCase().replace(CODE_SAFE, '_')}_${suffix}`;
}

/**
 * Turn `{ id }` or `{ key }` into an id.
 *
 * - both supplied  → INVALID_OPTIONS
 * - neither        → INVALID_OPTIONS, naming both options
 * - id supplied    → returned as-is (no network call)
 * - key supplied   → one `list()` call, then exact-match on the key
 *   - 0 matches    → `<NOUN>_NOT_FOUND`, naming the list command
 *   - >1 matches   → `<NOUN>_AMBIGUOUS`, listing every candidate. Nothing acts.
 */
export async function resolveResourceId<T>(
  target: ResolveTarget,
  spec: ResolveSpec<T>,
): Promise<string> {
  const { id, key } = target;
  const hasId = id !== undefined && id !== '';
  const hasKey = key !== undefined && key !== '';

  if (hasId && hasKey) {
    throw new ResolveError(
      'INVALID_OPTIONS',
      `Pass either ${spec.idOption} or ${spec.keyOption}, not both.`,
    );
  }
  if (!hasId && !hasKey) {
    throw new ResolveError(
      'INVALID_OPTIONS',
      `Missing target: pass ${spec.idOption} <id> or ${spec.keyOption} <${spec.keyLabel}>. ` +
        `Run \`${spec.listCommand}\` to see existing ${spec.keyLabel}s.`,
    );
  }
  if (hasId) return id as string;

  const normalize = spec.normalize ?? ((v: string) => v);
  const wanted = normalize(key as string);
  const items = await spec.list();
  const matches = items.filter((item) => {
    const candidate = spec.keyOf(item);
    return candidate !== undefined && candidate !== null && normalize(candidate) === wanted;
  });

  if (matches.length === 0) {
    throw new ResolveError(
      codeFor(spec.noun, 'NOT_FOUND'),
      `${spec.noun} not found: ${key}. Run \`${spec.listCommand}\` to see existing ${spec.keyLabel}s.`,
    );
  }

  if (matches.length > 1) {
    const describe = spec.describe ?? ((item: T) => `${spec.idOf(item)}`);
    const candidates = matches.map((m) => `  - ${describe(m)}`).join('\n');
    throw new ResolveError(
      codeFor(spec.noun, 'AMBIGUOUS'),
      `Ambiguous ${spec.keyLabel} "${key}" — it matches ${matches.length} ` +
        `${spec.noun.toLowerCase()}s:\n${candidates}\n` +
        `Nothing was changed. Re-run with ${spec.idOption} <id> to pick one.`,
    );
  }

  return spec.idOf(matches[0]);
}

// ── per-noun resolvers ──────────────────────────────────────────────────────
//
// One function per noun so no command hand-rolls a `list().find()`. Each is a
// thin `resolveResourceId` call describing where that noun's key lives.

/** `bridge flag …` — flag keys are unique. */
export function resolveFlagId(target: ResolveTarget): Promise<string> {
  return resolveResourceId(target, {
    noun: 'Flag',
    idOption: '--id',
    keyOption: '--key',
    keyLabel: 'key',
    listCommand: 'bridge flag list',
    list: () => getManagementClient().flags.list(),
    idOf: (f) => f.id,
    keyOf: (f) => f.key,
    describe: (f) => `${f.key} (id ${f.id})`,
  });
}

/** `bridge role …` — role keys are unique (e.g. ADMIN). */
export function resolveRoleId(target: ResolveTarget): Promise<string> {
  return resolveResourceId(target, {
    noun: 'Role',
    idOption: '--id',
    keyOption: '--key',
    keyLabel: 'key',
    listCommand: 'bridge role list',
    list: () => getManagementClient().roles.list(),
    idOf: (r) => r.id,
    keyOf: (r) => r.key,
    describe: (r) => `${r.key} — ${r.name} (id ${r.id})`,
  });
}

/**
 * `bridge tenant …` — tenants have NO key field. `name` is optional and the
 * platform does not enforce uniqueness on it, so a duplicate name is a real
 * possibility and always fails loudly rather than picking one.
 */
export function resolveTenantIdByName(target: ResolveTarget): Promise<string> {
  return resolveResourceId(target, {
    noun: 'Tenant',
    idOption: '--id',
    keyOption: '--name',
    keyLabel: 'name',
    listCommand: 'bridge tenant list',
    list: () => getManagementClient().tenants.list(),
    idOf: (t) => t.id,
    keyOf: (t) => t.name,
    describe: (t) =>
      `${t.name ?? '(unnamed)'} — id ${t.id}` +
      (t.signupBy?.email ? `, owner ${t.signupBy.email}` : '') +
      (t.createdAt ? `, created ${t.createdAt}` : ''),
  });
}

/**
 * `bridge user …` — users have no key either; email is the natural
 * human-readable identifier and is unique within a tenant. Matched
 * case-insensitively, as email addresses are.
 */
export function resolveUserId(target: ResolveTarget, tenantId: string): Promise<string> {
  return resolveResourceId(target, {
    noun: 'User',
    idOption: '--user-id',
    keyOption: '--email',
    keyLabel: 'email',
    listCommand: 'bridge user list',
    list: () => getManagementClient().users.list(tenantId),
    idOf: (u) => u.id,
    keyOf: (u) => u.email ?? u.username,
    normalize: (v) => v.toLowerCase(),
    describe: (u) =>
      `${u.email ?? u.username}${u.fullName ? ` — ${u.fullName}` : ''} (id ${u.id})`,
  });
}

/**
 * TBP-592 — turn privilege KEYS into the ids `POST/PUT /account/role` stores.
 *
 * `--privileges` is documented as taking keys, and keys are the only form a
 * human or agent has: they are what `bridge role list` prints and what the app
 * is designed around. But `role.model.ts` types `privileges` as
 * `Types.ObjectId[]` and resolves them with `findByIdsAndApp`, so a key
 * resolved to nothing, the array came back empty, and the model's pre-save
 * hook threw "A role needs at least one privilege".
 *
 * That error is the real cost. It reads as "you passed none" when the truth is
 * "the ones you passed were dropped", and nothing in it points at keys-vs-ids —
 * the only way to find out was to read the model.
 *
 * So: resolve here, and make an unknown identifier a hard failure that NAMES
 * the offenders. Silently dropping one privilege out of ten would create a role
 * that looks right and under-permits, which is worse than any error.
 *
 * Ids are still accepted and passed through untouched. Mixed input works. That
 * keeps `--privileges` honest for scripts that already pass ids, and means no
 * caller has to know which form the API wants.
 */
export async function resolvePrivilegeIds(identifiers: string[]): Promise<string[]> {
  const wanted = identifiers.map((v) => v.trim()).filter((v) => v !== '');
  if (wanted.length === 0) return [];

  const privileges = await getManagementClient().roles.listPrivileges();
  const byKey = new Map(privileges.map((p) => [p.key, p.id]));
  const knownIds = new Set(privileges.map((p) => p.id));

  const resolved: string[] = [];
  const unknown: string[] = [];

  for (const identifier of wanted) {
    const id = byKey.get(identifier);
    if (id !== undefined) {
      resolved.push(id);
    } else if (knownIds.has(identifier)) {
      resolved.push(identifier); // already an id
    } else {
      unknown.push(identifier);
    }
  }

  if (unknown.length > 0) {
    const available = privileges.map((p) => p.key).sort();
    throw new ResolveError(
      'PRIVILEGE_NOT_FOUND',
      `Unknown privilege${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.\n` +
        `Nothing was changed. Available privileges: ${available.join(', ') || '(none defined)'}.\n` +
        `Run \`bridge role list\` to see which roles use them.`,
    );
  }

  // De-duplicate: two spellings of the same privilege (its key and its id) must
  // not produce a doubled entry in the stored array.
  return [...new Set(resolved)];
}

/**
 * `bridge privilege …` — privilege keys are unique within an app, so a key
 * addresses exactly one. Same shape as `resolveRoleId`.
 */
export function resolvePrivilegeId(target: ResolveTarget): Promise<string> {
  return resolveResourceId(target, {
    noun: 'Privilege',
    idOption: '--id',
    keyOption: '--key',
    keyLabel: 'key',
    listCommand: 'bridge privilege list',
    list: () => getManagementClient().roles.listPrivileges(),
    idOf: (p) => p.id,
    keyOf: (p) => p.key,
    describe: (p) => `${p.key}${p.description ? ` — ${p.description}` : ''} (id ${p.id})`,
  });
}

/**
 * `bridge token …` — API tokens have no key; `name` is free text and is NOT
 * enforced unique, so two tokens can legitimately share one.
 */
export function resolveTokenIdByName(target: ResolveTarget): Promise<string> {
  return resolveResourceId(target, {
    noun: 'Token',
    idOption: '--id',
    keyOption: '--name',
    keyLabel: 'name',
    listCommand: 'bridge token list',
    list: () => getManagementClient().tokens.list(),
    idOf: (t) => t.id,
    keyOf: (t) => t.name,
    describe: (t) =>
      `${t.name} — id ${t.id}` + (t.createdAt ? `, created ${t.createdAt}` : ''),
  });
}
