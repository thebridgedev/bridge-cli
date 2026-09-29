/**
 * TBP-705 — `bridge guide mechanisms` prints the one page the other guides
 * build on. The owner asked for every mechanism and level to be documented;
 * these assertions pin the ones that page exists to carry, so a later edit
 * that drops one fails here instead of silently leaving agents without it.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { Command } from 'commander';
import { registerCommands } from '../program';
import { fetchMechanismsGuide } from '../commands/guide.command';

describe('bridge guide mechanisms', () => {
  it('is a registered guide command', () => {
    const program = new Command();
    registerCommands(program);
    const guide = program.commands.find((c) => c.name() === 'guide')!;
    expect(guide.commands.map((c) => c.name())).toContain('mechanisms');
  });

  it('prints the bundled page', async () => {
    const page = await fetchMechanismsGuide();
    expect(page).toMatch(/^# How Bridge works/);
  });

  it('prefers BRIDGE_GUIDE_LOCAL_DIR and falls back to the bundled page when the file is not there', async () => {
    const before = process.env.BRIDGE_GUIDE_LOCAL_DIR;
    process.env.BRIDGE_GUIDE_LOCAL_DIR = '/nonexistent-bridge-guide-dir';
    try {
      await expect(fetchMechanismsGuide()).resolves.toMatch(/^# How Bridge works/);
    } finally {
      if (before === undefined) delete process.env.BRIDGE_GUIDE_LOCAL_DIR;
      else process.env.BRIDGE_GUIDE_LOCAL_DIR = before;
    }
  });

  describe('carries every mechanism the owner asked for', () => {
    let page: string;
    beforeAll(async () => {
      page = await fetchMechanismsGuide();
    });

    it.each([
      ['the minimal frontend footprint', /export const load = bridgeBootstrap\(/],
      ['the minimal backend footprint', /BridgeModule\.forRoot\(\{ guard: \{ global: true \} \}\)/],
      ['asks where the action happens', /\*\*does this action call your server\?\*\*/],
      ['with a backend: the handler counts and refuses', /the backend handler counts it and refuses at the limit/],
      ['counted once, never in both places', /Never both for one metric/],
      ['a POST increments the limit', /A POST increments the limit/],
      [
        'counter vs gauge in one sentence',
        /If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it\./,
      ],
      ['UI level 0, the upgrade dialog', /\*\*0 — nothing\*\*.*upgrade dialog/],
      ['UI level 1, QuotaGate and a flag with the upgrade prompt', /<QuotaGate metric=.*<FeatureFlag key="analytics" upgrade>/],
      ['no upgrade dialog opens by itself', /No upgrade dialog opens by itself/],
      ['UI level 2, useQuota and a flag', /useQuota\('tickets'\)`, and `<FeatureFlag key="analytics">`/],
      ['browser counting is complete and first-class', /complete, first-class way to run limits/],
      ['rung 1, the token contract', /--bridge-primary/],
      ['rung 2, frame and heading', /frame\(page, children\)`.*heading\(page\)/],
      ['rung 3, take over a page', /src\/routes\/auth\/login\/\+page\.svelte/],
      ['rung 4, headless', /getBridgeAuth\(\)/],
      ['/welcome is offered, never created unasked', /offered, never created unasked/],
      // TBP-763 — seats are a named limit counted from membership, checked where invites happen.
      ['seats: a named gauge counted from membership', /--metric seats --limit 10 --policy hard --kind gauge --source membership/],
      ['seats: pending invites count', /active members, pending invites included/],
      ['seats: the team page setting', /<TeamManagementPanel seatsMetric="seats" \/>/],
      ['seats: the own-handler decorator', /`@RequireQuota\('seats'\)` on your own invite handler/],
      ['seats: the invite API does not refuse', /Bridge's invite API does not refuse at the limit/],
      ['seats: never a flag or an entitlement', /Never gate seats with a flag or an entitlement/],
    ])('%s', (_name, pattern) => {
      expect(page).toMatch(pattern);
    });
  });
});
