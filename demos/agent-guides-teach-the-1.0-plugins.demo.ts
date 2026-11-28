import { test, expect } from '../demo-kit';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TBP-M47 (AI agents & MCP): TBP-292 (the agent guides teach the 1.0 plugins and CLI 1.0, read from each plugin's 1.0 line),
 * with TBP-812 (verify steps split into terminal and browser checks), TBP-355 (the 1.0 NestJS server guides), TBP-831 (the look
 * guide reads the app's own styling) and TBP-356 (the CLI 1.0 guide command), all on feat/m47-guides.
 *
 * Runs on the one-machine stack (bridge-server tools/local/chain.sh) built from feat/m47-guides, with the SDKs packed from the
 * plugin worktrees. Stand-ins, said in the captions: the guides are read from a local copy of the feat/m47-guides branches laid out
 * as GitHub serves them (MCP_GUIDES_BASE_URL / BRIDGE_GUIDES_BASE_URL); the assistant is a small script making the same MCP calls
 * an assistant makes (ask-mcp.mjs), with an app key and one of the app's workspaces instead of the assistant's own sign-in; the app's Bridge files are written by a script that copies the guide's code blocks as given
 * (build-from-guide.mjs); React's 0.x guide is read from the local bridge-react main branch; the stack has no mail provider, so the confirmation email is read from the local provider's file.
 *
 * Warm-up (before the run, no secret printed): /tmp/m47/warm-up.sh makes a Child App with a developer, signs the CLI in, makes an
 * app key for the MCP calls (/tmp/m47/warm/mcp-token, 0600) and the flag `reports` (on). State: /tmp/m47/warm/state.env.
 *
 * Re-run:
 *   PORT_OFFSET=<o> ~/Workflows/bin/run-demo.sh TBP-M47 <bridge-cli>/demos/agent-guides-teach-the-1.0-plugins.demo.ts --base-url http://localhost:<5173+o>
 *
 * Ports: PORT_OFFSET (warm-up writes it to state.env) moves the host ports only (Bridge 3000+o, the app 5173+o, Live 3443+o). Inside
 * the stack Bridge's base stays http://localhost:3000, so the CLI and the MCP calls run in the tools container m47-tools, in the
 * bridge container's network namespace (each command is shown as the developer types it), and the browser's requests for :3000
 * and :3443 are rerouted to the host ports.
 */

const WARM = process.env.DEMO_WARM_DIR ?? '/tmp/m47/warm';
const TOOLS = process.env.DEMO_TOOLS_DIR ?? '/tmp/m47/demo';
const HOME = process.env.HOME ?? '';
const SERVER = process.env.DEMO_BRIDGE_SERVER_DIR ?? `${HOME}/code/nebulr/thebridge-platform/worktrees/bridge-server/m47-guides`;
const APP = process.env.DEMO_APP_DIR ?? '/tmp/m47/app/reports-app';
const APP_CONTAINER = 'm47-app';
const NODE_BIN = `${HOME}/.nvm/versions/node/v22.14.0/bin`;

const state = (): Record<string, string> =>
	Object.fromEntries(
		readFileSync(join(WARM, 'state.env'), 'utf8')
			.split('\n')
			.filter((l) => l.includes('='))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
	);

const flat = (text: string) => text.replace(/\s+/g, ' ');

/** The files `npx sv create --template minimal --types ts` writes, plus the app's own Reports page. No Bridge in it yet. */
function scaffold(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	const w = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	w('package.json', JSON.stringify({ name: 'reports-app', private: true, version: '0.0.1', type: 'module', scripts: { dev: 'vite dev', build: 'vite build' }, devDependencies: { '@sveltejs/adapter-auto': '^6.0.0', '@sveltejs/kit': '^2.16.0', '@sveltejs/vite-plugin-svelte': '^5.0.0', svelte: '^5.0.0', typescript: '^5.0.0', vite: '^6.2.6' } }, null, 2) + '\n');
	w('svelte.config.js', "import adapter from '@sveltejs/adapter-auto';\nimport { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\n\nexport default { preprocess: vitePreprocess(), kit: { adapter: adapter() } };\n");
	w('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit()] });\n");
	w('tsconfig.json', JSON.stringify({ extends: './.svelte-kit/tsconfig.json', compilerOptions: { strict: true, moduleResolution: 'bundler' } }, null, 2) + '\n');
	w('src/app.html', '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t%sveltekit.head%\n\t</head>\n\t<body data-sveltekit-preload-data="hover">\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n');
	w('src/app.d.ts', 'declare global {\n\tnamespace App {}\n}\n\nexport {};\n');
	w('src/routes/+page.svelte', '<h1>Welcome to SvelteKit</h1>\n<p><a href="/reports">Reports</a></p>\n');
	w('src/routes/reports/+page.svelte', '<h1>Reports</h1>\n<p>This month: 42 orders, 3 refunds.</p>\n<p><a href="/">Home</a></p>\n');
}

/** The newest email the stack's local mail provider kept for `to`, after `count` earlier ones. */
async function mailFor(container: string, to: string, timeoutMs = 60_000): Promise<{ subject: string; text: string }> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const raw = execFileSync('docker', ['exec', container, 'sh', '-c', 'cat /run/chain/mail.jsonl 2>/dev/null || true'], { encoding: 'utf8' });
		const mails = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string | string[]; subject: string; text: string });
		const mine = mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).some((t) => String(t).toLowerCase().includes(to.toLowerCase())));
		if (mine.length > 0) return mine[mine.length - 1]!;
		if (Date.now() > until) throw new Error(`no email for ${to} within ${timeoutMs / 1000} s`);
		await new Promise((r) => setTimeout(r, 1000));
	}
}

async function waitUp(url: string, ms = 180_000): Promise<void> {
	for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 2000))) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).status < 500) return;
		} catch {
			// not up yet
		}
		if (Date.now() > until) throw new Error(`${url} did not come up`);
	}
}

test('Agent guides teach the 1.0 plugins and CLI 1.0, read from each plugin\'s 1.0 line', async ({ demo }) => {
	test.setTimeout(20 * 60 * 1000);
	const { page, step, click, show } = demo;
	const terminal: typeof demo.terminal = (command, options) => demo.terminal(`${IN_TOOLS}${command}`, options);
	const s = state();
	const token = readFileSync(join(WARM, 'mcp-token'), 'utf8').trim();
	expect(token, 'the warm-up made an MCP key').not.toBe('');
	const stamp = Date.now().toString(36);
	const person = { email: `riley.${stamp}@reports-demo.dev`, password: `Reports-${stamp}-Aa1!` };

	const offset = Number(process.env.PORT_OFFSET ?? s['PORT_OFFSET'] ?? '0');
	const APP_ORIGIN = `http://localhost:${5173 + offset}`;
	// The browser reaches Bridge and Live on the host ports; the app, the issuer and the tokens keep naming :3000 and :3443.
	if (offset !== 0) {
		await page.context().route(/^http:\/\/localhost:3000\//, (route) => route.continue({ url: route.request().url().replace('localhost:3000', `localhost:${3000 + offset}`) }));
		await page.context().routeWebSocket(/^wss?:\/\/localhost:3443\//, (ws) => {
			ws.connectToServer(ws.url().replace('localhost:3443', `localhost:${3443 + offset}`));
		});
	}
	const cliEnv = {
		PATH: `${NODE_BIN}:/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH ?? ''}`,
		BRIDGE_ISSUER: s['ISSUER']!,
		MCP_TOKEN: token,
		MCP_WORKSPACE: s['MCP_WORKSPACE']!
	};
	/** `bridge …` runs the worktree's CLI in m47-tools (Bridge's namespace), in the same directory (mounted at the same path). */
	const IN_TOOLS = `bridge() { d="\${PWD#/private}"; case "$d" in /tmp/m47/*) ;; *) d=/tmp;; esac; docker exec -w "$d" -e BRIDGE_ISSUER m47-tools bridge "$@"; }; `;
	const assistant = { env: cliEnv, redact: [token, person.password], title: 'assistant (MCP)', promptDir: 'reports-app', timeoutMs: 180_000 };
	const dev = { env: cliEnv, redact: [token, person.password], title: 'reports-app — a SvelteKit app', promptDir: 'reports-app', timeoutMs: 180_000 };
	const ask = (args: string) => `docker exec -e MCP_TOKEN -e MCP_WORKSPACE -e LINES m47-tools node ${TOOLS}/ask-mcp.mjs ${args}`;

	try {
		await step("An assistant connected to Bridge's MCP server asks for each guide: every one comes from the 1.0 line (the plugins' and the CLI's v1 branches; here a local copy of them)", async () => {
			const { output } = await terminal(`${ask('guides')} | cut -c1-118`, { ...assistant, clear: true, shown: '# the assistant calls get_integration_guide for every topic' });
			expect(output).toContain('bridge-svelte/v1/mcp/');
			expect(output).toContain('bridge-nestjs/v1/mcp/');
			expect(output).toContain('bridge-cli/v1/bridge-cli/prompts/');
			expect(output).not.toContain('/main/');
		});

		await step("Asked for React, which has no 1.0 plugin yet, the old 0.x guide comes under a warning: it does not work with this Bridge, tell the developer, and use auth-core's 1.0 guides instead", async () => {
			const { output } = await terminal(`LINES=10 ${ask('guide integration react')} | fold -s -w 118`, { ...assistant, clear: true, shown: '# get_integration_guide topic=integration framework=react' });
			expect(flat(output)).toMatch(/no 1\.0 plugin/i);
			expect(flat(output)).toMatch(/auth-core|bridge guide javascript/);
		});

		await step('The add-paid-plan journey splits its checks: terminal checks any assistant runs, browser checks handed to the developer, and a "Heads up: not verified in a browser" line when they were not run', async () => {
			const { output } = await terminal(`${ask('prompt add-paid-plan')} | fold -s -w 118`, { ...assistant, clear: true, shown: '# prompts/get add-paid-plan' });
			expect(output).toContain('Terminal checks');
			expect(output).toContain('Browser checks');
			expect(flat(output)).toContain('Heads up: not verified in a browser');
			expect(flat(output)).toContain('bridge check gates');
		});

		await step('Without MCP, the CLI 1.0 guide command lists the same guides, each framework with its 1.0 topics, and the frameworks with no 1.0 plugin yet', async () => {
			const { output } = await terminal(`bridge guide list | jq -c '.data | {shared, frameworks, noPluginYet}' | fold -w 118`, { ...dev, clear: true, shown: 'bridge guide list' });
			expect(output).toContain('"svelte"');
			expect(output).toContain('"noPluginYet":["react"');
		});

		await step('`bridge guide` is the 1.0 main setup guide: the alpha install, one issuer setting, and only CLI 1.0 commands', async () => {
			const { output } = await terminal(`bridge guide | sed -n '1,14p' | fold -s -w 118`, { ...dev, clear: true, shown: 'bridge guide' });
			expect(output).toContain('(1.0)');
			expect(output).toContain('@alpha');
			expect(flat(output)).toContain('one setting, the app\'s issuer');
		});

		await step('`bridge guide react` says plainly that React has no 1.0 plugin yet, and what to use instead', async () => {
			const { output } = await terminal(`bridge guide react | fold -s -w 118`, { ...dev, clear: true, shown: 'bridge guide react' });
			expect(output).toContain('react has no 1.0 plugin yet');
			expect(output).toContain('createBridge({ issuer })');
		});

		await step('A plain SvelteKit app, fresh from the scaffold, with its own Reports page and no Bridge in it yet', async () => {
			scaffold(APP);
			const { output } = await terminal(`find . -type f | sort && grep -rc bridge src | grep -v ':0' || echo "no Bridge yet"`, { ...dev, cwd: APP, clear: true, shown: 'find . -type f; grep -r bridge src' });
			expect(output).toContain('./src/routes/reports/+page.svelte');
			expect(output).toContain('no Bridge yet');
		});

		await step('The guide\'s first step, `bridge app setup`, writes the one issuer setting into .env and adds the app\'s addresses on Bridge', async () => {
			const { output } = await terminal(`bridge app setup --url ${APP_ORIGIN} --dotenv .env && cat .env`, { ...dev, cwd: APP, clear: true, shown: `bridge app setup --url ${APP_ORIGIN}` });
			expect(output).toContain('PUBLIC_BRIDGE_ISSUER=http://localhost:3000/identity-access/apps/');
			expect(readFileSync(join(APP, '.env'), 'utf8')).toContain(s['CHILD_APP']!);
		});

		await step("The app's Bridge files are written from the guides alone: `bridge guide svelte` (sign-in) and `bridge guide svelte feature-flags` (a route rule closing /reports while the flag is off)", async () => {
			const { output } = await terminal(
				`bridge guide svelte --json > /tmp/m47/app/i.json && bridge guide svelte feature-flags --json > /tmp/m47/app/f.json && ${NODE_BIN}/node ${TOOLS}/build-from-guide.mjs . /tmp/m47/app/i.json /tmp/m47/app/f.json && sed -n '1,20p' src/routes/+layout.ts`,
				{ ...dev, cwd: APP, clear: true, shown: '# every code block the guides name a file for, copied as given' }
			);
			expect(output).toContain('src/routes/auth/[...bridge]/+page.svelte');
			expect(output).toContain("featureFlag: 'reports'");
		});

		await step('The app runs (vite dev, with the 1.0 plugin packed from its worktree in place of npm\'s alpha): the home page offers sign-in', async () => {
			execSync(`docker rm -f ${APP_CONTAINER} >/dev/null 2>&1 || true`);
			execFileSync('docker', [
				'run', '-d', '--name', APP_CONTAINER, '--memory', '1g', '--network', `container:${s['BRIDGE_CONTAINER']}`,
				'-v', `${APP}:/w`, '-v', `${SERVER}/tools/local/.run/svelte-app/node_modules:/w/node_modules`, '-w', '/w', '-e', 'HOME=/tmp',
				'mcr.microsoft.com/playwright:v1.64.1-noble', 'node_modules/.bin/vite', 'dev', '--port', '5173', '--strictPort', '--host', '0.0.0.0'
			], { stdio: 'ignore' });
			await waitUp(`${APP_ORIGIN}/`);
			await page.goto('/');
			await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible({ timeout: 120_000 });
			await show(page.getByRole('link', { name: /sign in/i }));
		});

		await step('A visitor signs up on the app\'s own sign-up page, which the plugin serves', async () => {
			await page.goto('/auth/sign-up');
			await expect(page.locator('#signup-email')).toBeVisible({ timeout: 60_000 });
			if (await page.locator('#signup-first-name').isVisible()) {
				await demo.type(page.locator('#signup-first-name'), 'Riley');
				await demo.type(page.locator('#signup-last-name'), 'Reader');
			}
			await demo.type(page.locator('#signup-email'), person.email);
			await demo.type(page.locator('#signup-password'), person.password);
			if (await page.locator('#signup-workspace').isVisible()) await demo.type(page.locator('#signup-workspace'), 'Riley\'s shop');
			await click(page.locator('form button[type="submit"]'));
			await expect(page.locator('[data-bridge-sign-up-step="sent"]')).toBeVisible({ timeout: 60_000 });
			await show(page.locator('[data-bridge-sign-up-step="sent"]'));
		});

		await step("The confirmation email's link (read from the stack's local mail file: one machine has no mail provider) finishes the sign-up in the app: signed in", async () => {
			const mail = await mailFor(String(s['BRIDGE_CONTAINER']), person.email);
			const link = /https?:\/\/[^\s)"'<>\]]+/g.exec(mail.text.split('\n').filter((l) => l.includes(APP_ORIGIN)).join('\n') || mail.text)?.[0];
			expect(link, 'the email carries a link to the app').toBeTruthy();
			expect(link).toContain(`${APP_ORIGIN}/auth`);
			await page.goto(link!);
			await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible({ timeout: 90_000 });
			await show(page.getByRole('button', { name: /sign out/i }));
		});

		await step('With the flag `reports` on, the Reports page opens', async () => {
			await page.goto('/reports');
			await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 60_000 });
			await show(page.getByRole('heading', { name: 'Reports' }));
		});

		await step('`bridge flag off reports` turns it off on Bridge', async () => {
			const { output } = await terminal(`bridge flag off reports | jq -c '.data | {key, state: (.state // .enabled)}'`, { ...dev, cwd: APP, clear: true, shown: 'bridge flag off reports' });
			expect(output).toContain('reports');
		});

		await step('The Reports page closes: opening it now goes back to the home page, by the route rule the guide wrote', async () => {
			let closed = false;
			for (let i = 0; i < 6 && !closed; i++) {
				await page.goto('/reports');
				await page.waitForTimeout(2500);
				closed = !(await page.getByRole('heading', { name: 'Reports' }).isVisible());
			}
			expect(closed, '/reports is closed while the flag is off').toBe(true);
			await expect(page).not.toHaveURL(/\/reports/);
			await show(page.getByRole('button', { name: /sign out/i }));
		});

		await step('`bridge check gates` is clean: every gate in the code the guides wrote is a flag', async () => {
			const { output } = await terminal(`bridge check gates | fold -s -w 118`, { ...dev, cwd: APP, clear: true, shown: 'npx @nebulr-group/bridge-cli@alpha check gates' });
			expect(flat(output)).toMatch(/no direct role, privilege, plan or plan-feature checks|"directChecks":\s*\[\]|clean/i);
		});

		await step('The NestJS 1.0 server guides teach where the server enforces: plan limits on the handler, how flags stay current with no flag webhook, and the plan webhooks', async () => {
			const { output } = await terminal(
				`bridge guide nestjs billing | grep -m2 -e 'The server enforces' -e '@Meter' | fold -s -w 118; echo; bridge guide nestjs feature-flags | grep -m1 'There is nothing to keep current' | fold -s -w 118`,
				{ ...dev, clear: true, shown: 'bridge guide nestjs billing; bridge guide nestjs feature-flags' }
			);
			expect(flat(output)).toContain('The server enforces');
			expect(flat(output)).toContain('Bridge sends no webhook for flag changes');
		});

		await step("The look guide tells the assistant to read the app's own styling (its CSS variables, Tailwind theme) and set Bridge's --bridge-* tokens from it", async () => {
			const { output } = await terminal(`bridge guide svelte branding | grep -m6 -e '--bridge-\\*' -e 'Tailwind' -e '--bridge-primary' | cut -c1-118`, { ...dev, clear: true, shown: 'bridge guide svelte branding' });
			expect(output).toContain('--bridge-');
			expect(output).toContain('Tailwind');
		});
	} finally {
		execSync(`docker rm -f ${APP_CONTAINER} >/dev/null 2>&1 || true`);
		if (existsSync(APP)) rmSync(join(APP, '.svelte-kit'), { recursive: true, force: true });
	}
});
