// TBP-952 — one guide holds every success message, and each main guide points
// at its own. An agent that skipped the flags or billing main guide (it went
// straight to a per-framework guide) still finds its message there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompts = join(__dirname, '..', '..', 'prompts');
const read = (p: string) => readFileSync(join(prompts, p), 'utf-8');

describe('success messages (TBP-952)', () => {
  const success = read('integration-success.md');

  it('holds sign-in, billing and flags messages, in that order, each with the banner and the footprint', () => {
    const heads = ['MESSAGE 1: sign-in', 'MESSAGE 2: plans, billing or plan limits', 'MESSAGE 3: feature flags'];
    const at = heads.map((h) => success.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const guide = success.indexOf('\n---\nAGENT SUBSTITUTION GUIDE');
    const bodies = [success.slice(at[0], at[1]), success.slice(at[1], at[2]), success.slice(at[2], guide)];
    for (const body of bodies) {
      expect(body).toContain('██████╗');
      expect(body).toContain('[footprint]');
      expect(body).toContain('[see-every-change]');
    }
    expect(bodies[1]).toContain('Billing is live in [project-name]');
    expect(bodies[2]).toContain('Feature flags are live in [project-name]');
  });

  it('explains every placeholder the billing and flags messages use', () => {
    for (const p of ['plan-names', 'subscription-route', 'paywall-summary', 'quota-summary', 'identity-source']) {
      expect(success).toContain(`PLACEHOLDER: ${p}`);
    }
  });

  it.each([
    ['auth-master-integration-prompt.md', 'MESSAGE 1'],
    ['billing/master.md', 'MESSAGE 2'],
    ['flags/master.md', 'MESSAGE 3'],
  ])('%s sends the agent to %s and keeps no banner copy of its own', (file, message) => {
    const master = read(file);
    expect(master).toContain(message);
    expect(master).toContain('get_integration_guide` topic `integration-success`');
    if (file !== 'auth-master-integration-prompt.md') expect(master).not.toContain('██████╗');
  });
});
