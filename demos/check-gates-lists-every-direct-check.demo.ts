import { test, expect } from '../demo-kit';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-705 (milestone TBP-M35): every gate in app code is a flag, and
 * `bridge check gates` proves it before an integration is called done.
 *
 * The project holds the two lines from the owner's own run: a team link
 * gated by `canManageTeam = ['OWNER','ADMIN'].includes(role)` and an
 * analytics link inside `<Entitled to="analytics">`. The published CLI beta
 * lists both, with the flag to use instead, and exits 1. After both become
 * `<FeatureFlag>`s it exits 0. Last, Bridge's MCP server hands the same rule
 * to every connected agent in its startup instructions.
 *
 * The CLI runs in one throwaway node:22 container (memory preflight first).
 * The MCP call uses a read-only API token for a throwaway stage app (masked),
 * minted through the stage test endpoints keyed by PLAYWRIGHT_TEST_API_KEY
 * from bridge-api/config/.env.stage (never printed); the app is deleted at the end.
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-705 bridge-plugins/bridge-cli/demos/check-gates-lists-every-direct-check.demo.ts
 */

const STAGE = 'https://api-stage.thebridge.dev';
const API_DIR = process.env.DEMO_BRIDGE_API_DIR ?? '/Users/imanpouya/code/nebulr/thebridge-platform/bridge-api';
const CLI_VERSION = process.env.DEMO_CLI_VERSION ?? '0.6.0-beta.8';
const DOMAIN = 'demo-check-gates';
const CONTAINER = 'demo-check-gates-cli';

function stageKey(): string {
	const line = readFileSync(join(API_DIR, 'config/.env.stage'), 'utf8')
		.split('\n')
		.find((l) => l.startsWith('PLAYWRIGHT_TEST_API_KEY='));
	const key = line?.slice('PLAYWRIGHT_TEST_API_KEY='.length).trim().replace(/^"|"$/g, '');
	if (!key) throw new Error('PLAYWRIGHT_TEST_API_KEY missing from bridge-api/config/.env.stage');
	return key;
}
const headers = () => ({ 'Content-Type': 'application/json', 'x-playwright-api-key': stageKey() });
async function post<T>(path: string, body: unknown): Promise<T> {
	const init = { method: 'POST', headers: headers(), body: JSON.stringify(body) };
	let res = await fetch(`${STAGE}/account/test/playwright/${path}`, init);
	if (!res.ok) {
		await new Promise((r) => setTimeout(r, 3000));
		res = await fetch(`${STAGE}/account/test/playwright/${path}`, init);
	}
	if (!res.ok) throw new Error(`POST ${path} answered ${res.status}: ${await res.text()}`);
	return (await res.json()) as T;
}
const removeApp = () => fetch(`${STAGE}/account/test/playwright/test-app`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ domain: DOMAIN }) }).catch(() => {});

const flat = (text: string) => text.replace(/\s+/g, ' ');

const TEAM_BEFORE = `<script lang="ts">
	import { user } from '@nebulr-group/bridge-svelte';
	const role = $derived($user?.role ?? '');
	const canManageTeam = $derived(['OWNER', 'ADMIN'].includes(role));
</script>

{#if canManageTeam}
	<a href="/team">Team</a>
{/if}
`;
const REPORTS_BEFORE = `<script lang="ts">
	import { Entitled } from '@nebulr-group/bridge-svelte';
</script>

<Entitled to="analytics">
	<a href="/reports/analytics">Analytics</a>
</Entitled>
`;
const TEAM_AFTER = `<script lang="ts">
	import { FeatureFlag } from '@nebulr-group/bridge-svelte';
</script>

<FeatureFlag key="manage-team">
	<a href="/team">Team</a>
</FeatureFlag>
`;
const REPORTS_AFTER = `<script lang="ts">
	import { FeatureFlag } from '@nebulr-group/bridge-svelte';
</script>

<FeatureFlag key="analytics">
	<a href="/reports/analytics">Analytics</a>
</FeatureFlag>
`;

test('Every gate is a flag, and one command finds the ones that are not', async ({ demo }) => {
	test.setTimeout(8 * 60 * 1000);
	const { step, terminal } = demo;

	const dir = mkdtempSync(join(tmpdir(), 'helpdesk-'));
	const w = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	w('package.json', JSON.stringify({ name: 'helpdesk', private: true }, null, 2));
	w('src/routes/+layout.svelte', TEAM_BEFORE);
	w('src/routes/reports/+page.svelte', REPORTS_BEFORE);

	await removeApp();
	await post('setup-test-app', { domain: DOMAIN, appName: 'Helpdesk', ownerEmail: `${DOMAIN}@example.com`, appUrl: 'http://localhost:5173' });
	const { token } = await post<{ token: string }>('generate-jwt', { appDomain: DOMAIN, privileges: ['AUTHENTICATED', 'USER_READ', 'TENANT_READ'] });
	const at = { cwd: dir, promptDir: 'helpdesk', title: 'helpdesk — a SvelteKit app', env: { BRIDGE_TOKEN: token }, redact: [token], timeoutMs: 240_000 };
	const { execSync } = await import('node:child_process');
	execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
	execSync(
		`docker run -d --rm --name ${CONTAINER} -v "${dir}":/w -w /w -e BRIDGE_NO_BANNER=true -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error node:22 sleep infinity >/dev/null && ` +
			`docker exec ${CONTAINER} npm i -g @nebulr-group/bridge-cli@${CLI_VERSION} >/dev/null 2>&1`
	);
	const bridge = (args: string) => `docker exec ${CONTAINER} bridge ${args}`;

	try {
		await step('The app from the owner’s run: the Team link checks the role in code, and the Analytics link checks the plan', async () => {
			const { output } = await terminal(`grep -n -e includes -e Entitled -r src`, { ...at, clear: true });
			expect(output).toContain("['OWNER', 'ADMIN'].includes(role)");
			expect(output).toContain('<Entitled to="analytics">');
		});

		await step('One command, the last step of every guide, lists both, says what to use instead, and fails', async () => {
			const { output, code } = await terminal(`${bridge('check gates')} | fold -s -w 118`, {
				...at,
				clear: true,
				shown: `npx @nebulr-group/bridge-cli@${CLI_VERSION} check gates`,
				expectExit: 'any'
			});
			expect(flat(output)).toContain('2 direct checks in 2 files');
			expect(flat(output)).toContain('role check');
			expect(flat(output)).toContain('plan-feature check');
			expect(code).toBe(0); // the pipe's exit; the command's own exit is shown next
		});

		await step('The command itself exits with 1, so an agent (or CI) cannot call the work done while a direct check is left', async () => {
			const { output } = await terminal(`${bridge('check gates')} > /dev/null; echo "exit code: $?"`, {
				...at,
				shown: `npx @nebulr-group/bridge-cli@${CLI_VERSION} check gates > /dev/null; echo "exit code: $?"`
			});
			expect(output).toContain('exit code: 1');
		});

		await step('Both links now ask a flag instead: the flag’s rule says why (a privilege, or the plan’s analytics feature)', async () => {
			w('src/routes/+layout.svelte', TEAM_AFTER);
			w('src/routes/reports/+page.svelte', REPORTS_AFTER);
			const { output } = await terminal(`grep -n FeatureFlag -r src`, { ...at, clear: true });
			expect(output).toContain('<FeatureFlag key="manage-team">');
			expect(output).toContain('<FeatureFlag key="analytics">');
		});

		await step('Run again: clean, exit code 0', async () => {
			const { output } = await terminal(`${bridge('check gates')} | fold -s -w 118; ${bridge('check gates')} > /dev/null; echo "exit code: $?"`, {
				...at,
				shown: `npx @nebulr-group/bridge-cli@${CLI_VERSION} check gates; echo "exit code: $?"`
			});
			expect(flat(output)).toContain('no direct role, privilege, plan or plan-feature checks');
			expect(output).toContain('exit code: 0');
		});

		await step('Every agent that connects to Bridge’s MCP server gets the same rule in its startup instructions, with the command', async () => {
			const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '1' } } };
			const { output } = await terminal(
				`curl -s ${STAGE}/mcp -H "Authorization: Bearer $BRIDGE_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' ` +
					`-d '${JSON.stringify(init)}' | jq -r '.result.instructions' | sed -n '1,/check gates/p' | fold -s -w 118`,
				{ ...at, clear: true, shown: 'claude  ›  initialize   # the instructions Bridge’s MCP server sends every agent' }
			);
			expect(flat(output)).toContain('Every gate in app code (a link, a page, a button, an endpoint) is a feature flag');
			expect(flat(output)).toContain('check gates');
		});
	} finally {
		execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
		rmSync(dir, { recursive: true, force: true });
		await removeApp();
	}
});
