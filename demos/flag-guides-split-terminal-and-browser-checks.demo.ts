import { test, expect } from '../demo-kit';

/**
 * TBP-M47 (AI agents & MCP): TBP-812, the flag guides' verify step split into terminal checks and browser checks, for
 * assistants without a browser. The paid-plan side is in agent-guides-teach-the-1.0-plugins.demo.ts (step 3, the MCP's
 * add-paid-plan journey); this shows the flag side.
 *
 * Terminal only. The guides are read from a local copy of the feat/m47-guides branches laid out as GitHub serves them
 * (BRIDGE_GUIDES_BASE_URL=http://localhost:4599, /tmp/m47/guides-serve.mjs); the CLI is the worktree's build (/tmp/m47/bin/bridge).
 * The MCP's add-feature-flag journey is shown from its source (bridge-server microservices/mcp/src/journeys.ts on
 * feat/m47-guides), which is the text prompts/get returns; no stack is started.
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-M47 <bridge-cli>/demos/flag-guides-split-terminal-and-browser-checks.demo.ts
 */

const HOME = process.env.HOME ?? '';
const SERVER = process.env.DEMO_BRIDGE_SERVER_DIR ?? `${HOME}/code/nebulr/thebridge-platform/worktrees/bridge-server/m47-guides`;
const flat = (text: string) => text.replace(/\s+/g, ' ');

test('The flag guides split their checks: terminal ones any assistant runs, browser ones handed to the developer', async ({ demo }) => {
	test.setTimeout(5 * 60 * 1000);
	const { step, terminal } = demo;
	const at = {
		env: { PATH: `/tmp/m47/bin:${process.env.PATH ?? ''}`, BRIDGE_NO_BANNER: 'true', BRIDGE_GUIDES_BASE_URL: 'http://localhost:4599' },
		title: 'my-app',
		promptDir: 'my-app'
	};

	await step('`bridge guide add-feature-flag`: the journey ends with terminal checks, numbered browser checks, and a "Heads up: not verified in a browser" line when they were not run', async () => {
		const { output } = await terminal(`bridge guide add-feature-flag | sed -n '1,9p' | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide add-feature-flag' });
		expect(flat(output)).toContain('Run the terminal checks. If you have a browser tool, run the browser checks too.');
		expect(output).toContain('Terminal checks:');
		expect(output).toContain('Browser checks: 1.');
		expect(flat(output)).toContain('Heads up: not verified in a browser');
	});

	await step('The flags guide (`bridge guide flags`): its terminal checks name only CLI 1.0 commands', async () => {
		const { output } = await terminal(`bridge guide flags | sed -n '/^## Step 5/,/^### Browser checks/p' | sed '$d' | cut -c1-230 | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide flags   # Step 5, Verify' });
		expect(output).toContain('### Terminal checks');
		expect(output).toContain('bridge flag get <key>');
		expect(output).toContain('check gates');
	});

	await step('Its browser checks are numbered for the developer, and an unverified summary must start with the Heads up line instead of the success banner', async () => {
		const { output } = await terminal(`bridge guide flags | sed -n '/^### Browser checks/,/^If anything fails/p' | fold -s -w 118; bridge guide flags | grep 'When a check failed or was not run' | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide flags   # browser checks, and the summary rule' });
		expect(output).toContain('### Browser checks');
		expect(output).toContain('1. Signed in as someone the flag is on for');
		expect(flat(output)).toContain('Heads up: not verified in a browser');
	});

	await step('The SvelteKit flag guide (`bridge guide svelte feature-flags`) has the same split and the same rule', async () => {
		const { output } = await terminal(`bridge guide svelte feature-flags | grep -e '^### Terminal checks' -e '^### Browser checks' -e 'Heads up: not verified in a browser' | fold -s -w 118`, { ...at, clear: true, shown: 'bridge guide svelte feature-flags' });
		expect(output).toContain('### Terminal checks');
		expect(output).toContain('### Browser checks');
		expect(flat(output)).toContain('Heads up: not verified in a browser');
	});

	await step("Bridge's MCP server gives an assistant the same add-feature-flag steps (its journey, as prompts/get returns it): terminal checks with CLI 1.0 commands, browser checks, the Heads up rule", async () => {
		const { output } = await terminal(
			`grep -n -e '^const VERIFY' -e '^const HEADS_UP' -A1 microservices/mcp/src/journeys.ts | cut -c1-300 | fold -s -w 118; echo; sed -n '/name: "add-feature-flag"/,/^    },/p' microservices/mcp/src/journeys.ts | grep -e 'Terminal checks' -e 'Browser checks' | sed 's/^ *//' | fold -s -w 118`,
			{ ...at, cwd: SERVER, promptDir: 'bridge-server', title: 'bridge-server (feat/m47-guides)', clear: true, shown: "# the MCP's add-feature-flag journey, in bridge-server's journeys.ts" }
		);
		expect(output).toContain('Terminal checks');
		expect(output).toContain('Browser checks');
		expect(output).toContain('bridge flag get <key>');
		expect(flat(output)).toContain('Heads up: not verified in a browser');
	});
});
