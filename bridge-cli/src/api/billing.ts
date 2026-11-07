import type { BridgeClient } from '../client.js';

/** A price per unit of a metric above what the price includes, in minor units as text ("0.25"). */
export interface UsagePrice {
  metric: string;
  unitAmount: string;
  included?: number;
}

/** A price in minor units (1999 for 19.99 EUR). `interval` is null for a one-time price. */
export interface Price {
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year' | null;
  amount: number;
  usage?: UsagePrice[];
}

export interface Feature {
  key: string;
  name?: string;
}

export interface Limit {
  metric: string;
  limit: number | null;
}

export interface Trial {
  days: number;
  cardRequired?: boolean;
}

/** A plan as one document: what it costs, what it includes and how much. */
export interface PlanFields {
  key?: string;
  name?: string;
  description?: string;
  prices?: Price[];
  features?: Feature[];
  limits?: Limit[];
  trial?: Trial | null;
}

export interface Plan extends PlanFields {
  readonly key: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly [field: string]: unknown;
}

export interface ProductFields {
  key?: string;
  kind?: 'addon' | 'one_time';
  name?: string;
  description?: string;
  prices?: Price[];
  features?: Feature[];
  /** How much one unit adds to a limit. */
  limits?: { metric: string; add: number }[];
}

export interface Metric {
  readonly key: string;
  readonly name: string;
  readonly kind: 'counter' | 'gauge';
}

export interface Tax {
  readonly country: string;
  readonly name: string;
  readonly basisPoints: number;
}

export interface BillingSettings {
  currency?: string | null;
  paymentsAutoRedirect?: boolean;
  returnUrl?: string | null;
}

const body = <T>(answer: { body: T }) => answer.body;

export const plans = {
  list: (c: BridgeClient, appId: string, archived = false) =>
    c.person<Plan[]>('plansList', { params: { appId }, query: { archived: archived ? 'true' : undefined } }).then(body),
  get: (c: BridgeClient, appId: string, key: string) => c.person<Plan>('plansGet', { params: { appId, key } }).then(body),
  create: (c: BridgeClient, appId: string, fields: PlanFields & { key: string; name: string }) =>
    c.person<Plan>('plansCreate', { params: { appId }, body: fields }).then(body),
  /** Creates the plan, or replaces it whole. */
  replace: (c: BridgeClient, appId: string, key: string, fields: PlanFields) =>
    c.person<Plan>('plansReplace', { params: { appId, key }, body: fields }).then(body),
  /** Changes only the fields named. */
  update: (c: BridgeClient, appId: string, key: string, fields: PlanFields) =>
    c.person<Plan>('plansUpdate', { params: { appId, key }, body: fields }).then(body),
  remove: (c: BridgeClient, appId: string, key: string) => c.person('plansDelete', { params: { appId, key } }).then(body),
  archive: (c: BridgeClient, appId: string, key: string, archived: boolean) =>
    c.person<Plan>('plansArchive', { params: { appId, key }, body: { archived } }).then(body),
  deletionPreview: (c: BridgeClient, appId: string, key: string) =>
    c.person<{ key: string; holders: number; deletable: boolean }>('plansDeletionPreview', { params: { appId, key } }).then(body),
};

export const products = {
  list: (c: BridgeClient, appId: string, archived = false) =>
    c.person<Plan[]>('productsList', { params: { appId }, query: { archived: archived ? 'true' : undefined } }).then(body),
  get: (c: BridgeClient, appId: string, key: string) => c.person('productsGet', { params: { appId, key } }).then(body),
  create: (c: BridgeClient, appId: string, fields: ProductFields & { key: string; name: string; kind: 'addon' | 'one_time' }) =>
    c.person('productsCreate', { params: { appId }, body: fields }).then(body),
  update: (c: BridgeClient, appId: string, key: string, fields: ProductFields) =>
    c.person('productsUpdate', { params: { appId, key }, body: fields }).then(body),
  remove: (c: BridgeClient, appId: string, key: string) => c.person('productsDelete', { params: { appId, key } }).then(body),
  archive: (c: BridgeClient, appId: string, key: string, archived: boolean) =>
    c.person('productsArchive', { params: { appId, key }, body: { archived } }).then(body),
};

export const metrics = {
  list: (c: BridgeClient, appId: string) => c.person<Metric[]>('metricsList', { params: { appId } }).then(body),
  set: (c: BridgeClient, appId: string, key: string, fields: { name?: string; kind: 'counter' | 'gauge' }) =>
    c.person<Metric>('metricsPut', { params: { appId, key }, body: fields }).then(body),
  remove: (c: BridgeClient, appId: string, key: string) => c.person('metricsDelete', { params: { appId, key } }).then(body),
};

export const taxes = {
  list: (c: BridgeClient, appId: string) => c.person<Tax[]>('taxesList', { params: { appId } }).then(body),
  set: (c: BridgeClient, appId: string, country: string, fields: { name: string; basisPoints: number }) =>
    c.person<Tax>('taxesPut', { params: { appId, country: country.toUpperCase() }, body: fields }).then(body),
  remove: (c: BridgeClient, appId: string, country: string) => c.person('taxesDelete', { params: { appId, country: country.toUpperCase() } }).then(body),
};

export const billingSettings = {
  get: (c: BridgeClient, appId: string) => c.person<BillingSettings>('billingSettingsGet', { params: { appId } }).then(body),
  update: (c: BridgeClient, appId: string, fields: BillingSettings) => c.person<BillingSettings>('billingSettingsUpdate', { params: { appId }, body: fields }).then(body),
};

export const connection = {
  get: (c: BridgeClient, appId: string) => c.person('connectionGet', { params: { appId } }).then(body),
  remove: (c: BridgeClient, appId: string) => c.person('connectionDelete', { params: { appId } }).then(body),
  /** Connects Stripe with a pasted secret key: the app-key route, the one version 2 offers for it. */
  pasteKey: (c: BridgeClient, appKey: string, fields: { secretKey: string; publishableKey?: string }) =>
    c.withKey('connectionPasteKey', appKey, { body: { connector: 'stripe', ...fields } }).then(body),
};
