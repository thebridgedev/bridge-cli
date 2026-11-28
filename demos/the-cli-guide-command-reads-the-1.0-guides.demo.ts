import { test, expect } from '../demo-kit';

/**
 * TBP-M48 (CLI improvements): TBP-356, the CLI 1.0 guide command reads the 1.0 guides (bridge-cli feat/m47-guides).
 *
 * Terminal only. The guides are read from a local copy of the feat/m47-guides branches laid out as GitHub serves them
 * (BRIDGE_GUIDES_BASE_URL=http://localhost:4599, /tmp/m47/guides-serve.mjs); unset, the CLI reads GitHub's v1 branches.
 * The CLI is the worktree's build (/tmp/m47/bin/bridge runs bridge-cli/dist/bin.js).
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-M48 <bridge-cli>/demos/the-cli-guide-command-reads-the-1.0-guides.demo.ts
 */

const HOME = process.env.HOME ?? '';
const CLI_DIR = process.env.DEMO_CLI_DIR ?? `${HOME}/code/nebulr/thebridge-platform/worktrees/new-features/bridge-cli-m47-guides`;
const flat = (text: string) => text.replace(/\s+/g, ' ');

test('The CLI 1.0 guide command teaches the 1.0 plugins and CLI 1.0 commands', async ({ demo }) => {
	test.setTimeout(5 * 60 * 1000);
	const { step, terminal } = demo;
	const at = {
		env: { PATH: `/tmp/m47/bin:${process.env.PATH ?? ''}`, BRIDGE_NO_BANNER: 'true', BRIDGE_GUIDES_BASE_URL: 'http://localhost:4599' },
		title: 'my-app',
		promptDir: 'my-app'
	};

	await step('`bridge guide list` (CLI 1.0 alpha): the shared guides, each 1.0 framework with its topics, and the frameworks with no 1.0 plugin yet', async () => {
		const { output } = await terminal(`bridge --version && bridge guide list | jq -c '.data | {shared, frameworks, noPluginYet}' | fold -w 118`, { ...at, clear: true, shown: 'bridge --version && bridge guide list' });
		expect(output).toContain('1.0.0-alpha');
		expect(output).toContain('"javascript":["integration","server"]');
	});

	await step('`bridge guide`: the main setup guide for 1.0, the alpha install, one issuer setting, and the app\'s addresses with CLI 1.0 commands', async () => {
		const { output } = await terminal(`bridge guide | grep -m6 -e '(1.0)' -e '@alpha' -e 'one setting' -e 'app setup' -e 'address add' | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide' });
		expect(output).toContain('(1.0)');
		expect(flat(output)).toContain('one setting, the app\'s issuer');
	});

	await step('`bridge guide flags`: each 1.0 plugin\'s own flag helpers and components, and auth-core for any other JavaScript app', async () => {
		const { output } = await terminal(`bridge guide flags | grep -m5 -e 'FeatureFlag' -e 'useFlag' -e 'auth-core' -e 'RequireFlag' | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide flags' });
		expect(output).toMatch(/FeatureFlag|useFlag/);
		expect(output).toContain('auth-core');
	});

	await step('`bridge guide react`: React has no 1.0 plugin yet, said plainly, instead of the 0.x guide', async () => {
		const { output } = await terminal(`bridge guide react | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide react' });
		expect(output).toContain('react has no 1.0 plugin yet');
	});

	await step('Every guide it printed was read from the 1.0 line (v1 branches), never from main, where the 0.x CLI and its guides are left as they were', async () => {
		const { output } = await terminal(
			`tail -n 40 /tmp/m47/guides-serve.log | awk '{print $2}' | sort -u; echo; echo "0.x line (main): $(git -C ${CLI_DIR} log -1 --format='%h %cs %s' origin/main | cut -c1-90)"; git -C ${CLI_DIR} merge-base --is-ancestor HEAD origin/main && echo "this work is on main" || echo "this work (feat/m47-guides, $(git -C ${CLI_DIR} rev-parse --short HEAD)) is not on main: CLI 0.x prints its guides as before"`,
			{ ...at, clear: true, shown: '# what the CLI read, and the 0.x line' }
		);
		expect(output).toContain('/v1/');
		expect(output).not.toMatch(/^\/[^ ]+\/main\//m);
	});
});
