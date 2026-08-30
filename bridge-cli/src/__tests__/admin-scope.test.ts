// TBP-593 — the opt-in elevated login scope.
//
// The default CLI login token carries no destructive privileges (TBP-552 made
// those opt-in per token). That left a bootstrap paradox: `bridge token create`
// needs TOKEN_WRITE, so a newly provisioned app could never be given its own
// API key through the CLI — and people worked around it by pointing production
// services at the 10-day login token itself.
//
// `--admin` asks for the extra authority out loud instead of everyone
// inheriting it silently.

import { privilegeHint } from '../output.js';
import { SCOPE_MANAGEMENT, SCOPE_MANAGEMENT_ADMIN } from '../auth/scopes.js';

describe('login scopes', () => {
  it('names the two scopes the server accepts', () => {
    expect(SCOPE_MANAGEMENT).toBe('management');
    expect(SCOPE_MANAGEMENT_ADMIN).toBe('management:admin');
  });
});

describe('privilegeHint (TBP-593)', () => {
  it('turns a bare privilege refusal into an actionable instruction', () => {
    const hint = privilegeHint("Privilege 'TOKEN_WRITE' required");
    expect(hint).toBeDefined();
    expect(hint).toContain('bridge auth login --admin');
    expect(hint).toContain('TOKEN_WRITE');
  });

  it('covers every privilege the admin scope adds', () => {
    for (const p of [
      'TOKEN_WRITE',
      'TENANT_DELETE',
      'USER_DELETE',
      'ROLE_DELETE',
      'FLAG_DELETE',
      'APP_DELETE',
      'BRANDING_DELETE',
      'COMMUNICATION_DELETE',
    ]) {
      expect(privilegeHint(`Privilege '${p}' required`)).toBeDefined();
    }
  });

  it('stays silent for privileges the admin scope would NOT fix', () => {
    // Suggesting --admin for a privilege it does not grant sends the reader on
    // a pointless round trip and erodes trust in the hint.
    expect(privilegeHint("Privilege 'USER_READ' required")).toBeUndefined();
    expect(privilegeHint("Privilege 'SOMETHING_ELSE' required")).toBeUndefined();
  });

  it('stays silent for unrelated messages', () => {
    expect(privilegeHint('Not found')).toBeUndefined();
    expect(privilegeHint('')).toBeUndefined();
  });
});
