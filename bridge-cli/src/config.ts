import { BridgeManagement } from '@nebulr-group/bridge-auth-core';

let _client: BridgeManagement | null = null;

export function getManagementClient(): BridgeManagement {
  if (_client) return _client;

  const apiKey = process.env.BRIDGE_API_KEY;
  if (!apiKey) {
    throw new ConfigError('BRIDGE_API_KEY environment variable is required.');
  }

  _client = new BridgeManagement({
    apiKey,
    baseUrl: process.env.BRIDGE_BASE_URL || undefined,
    debug: process.env.BRIDGE_DEBUG === 'true',
  });

  return _client;
}

export function resolveTenantId(opts: { tenantId?: string }): string {
  const tenantId = opts.tenantId || process.env.BRIDGE_TENANT_ID;
  if (!tenantId) {
    throw new ConfigError(
      'Tenant context required. Set BRIDGE_TENANT_ID environment variable or use --tenant-id flag.',
    );
  }
  return tenantId;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
