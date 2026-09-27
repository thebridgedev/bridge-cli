import { test, expect } from '../demo-kit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-705 (milestone TBP-M35): the guides teach the short integration, and
 * how limits really work.
 *
 * `bridge guide mechanisms` is one page with the whole integration (15
 * frontend lines, 4 backend lines), the rule that the backend decorator is the
 * increment, and the counter-vs-gauge sentence. The SvelteKit sign-in guide is
 * short now. And an agent asked "how do I limit tickets per plan?" answers
 * from Bridge with the decorator and a gauge, not a hand-written counter.
 *
 * Runs the published CLI beta in a container, and real `claude -p` with a
 * `.mcp.json` against stage. A stage demo app and a read-only API token come
 * from the stage test endpoints (keyed by PLAYWRIGHT_TEST_API_KEY from
 * bridge-api/config/.env.stage, never printed); the token only lives in the
 * scratch `.mcp.json`, masked. The app is deleted at the end.
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-705 bridge-plugins/bridge-cli/demos/the-guides-teach-the-ten-line-integration.demo.ts
 */

const STAGE = 'https://api-stage.thebridge.dev';
const API_DIR = process.env.DEMO_BRIDGE_API_DIR ?? '/Users/imanpouya/code/nebulr/thebridge-platform/bridge-api';
const CLI_VERSION = process.env.DEMO_CLI_VERSION ?? '0.6.0-beta.6';
const DOMAIN = 'demo-guides-short-integration';

function stageKey(): string {
	const line = readFileSync(join(API_DIR, 'config/.env.stage'), 'utf8')
		.split('\n')
		.find((l) => l.startsWith('PLAYWRIGHT_TEST_API_KEY='));
	const key = line?.slice('PLAYWRIGHT_TEST_API_KEY='.length).trim().replace(/^"|"$/g, '');
	if (!key) throw new Error('PLAYWRIGHT_TEST_API_KEY missing from bridge-api/config/.env.stage');
	return key;
}

const headers = () => ({ 'Content-Type': 'application/json', 'x-playwright-api-key': stageKey() });

/** Stage Lambdas answer a cold first call with a 5xx now and then; retry once. */
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

const removeApp = () =>
	fetch(`${STAGE}/account/test/playwright/test-app`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ domain: DOMAIN }) }).catch(() => {});

function bridge(dir: string, args: string): string {
	return (
		`docker run --rm -v "${dir}":/w -w /w -e BRIDGE_BASE_URL=${STAGE} -e BRIDGE_NO_BANNER=true ` +
		`-e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error node:22 npx -y @nebulr-group/bridge-cli@${CLI_VERSION} ${args}`
	);
}

test('The guides teach the short integration, and how plan limits really work', async ({ demo }) => {
	test.setTimeout(10 * 60 * 1000);
	const { step, terminal } = demo;

	await removeApp();
	await post('setup-test-app', { domain: DOMAIN, appName: 'Helpdesk', ownerEmail: `${DOMAIN}@example.com`, appUrl: 'http://localhost:5173' });
	const { token } = await post<{ token: string }>('generate-jwt', { appDomain: DOMAIN, privileges: ['AUTHENTICATED', 'USER_READ', 'TENANT_READ'] });

	const dir = mkdtempSync(join(tmpdir(), 'helpdesk-'));
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'helpdesk-api', private: true, dependencies: { '@nestjs/core': '^11', '@nebulr-group/bridge-nestjs': '^0.8.0-beta.0' } }, null, 2)
	);
	writeFileSync(
		join(dir, '.mcp.json'),
		JSON.stringify({ mcpServers: { bridge: { type: 'http', url: `${STAGE}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
	);
	const at = { cwd: dir, promptDir: 'helpdesk', title: 'helpdesk', redact: [token], timeoutMs: 240_000 };

	// Wake the stage Lambda before Claude Code's first call.
	await fetch(`${STAGE}/mcp`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
	}).catch(() => undefined);

	try {
		await step('One page now explains how Bridge works, and it opens with the whole integration a repo needs', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide mechanisms')} | head -12`, { ...at, clear: true, shown: 'bridge guide mechanisms | head -12' });
			expect(output).toContain('# How Bridge works');
			expect(output).toContain('15 lines in four files');
		});

		await step('The backend is four lines on top of a new NestJS project: two imports, the module, and one decorator on the route that creates something', async () => {
			const { output } = await terminal(
				`${bridge(dir, 'guide mechanisms')} | sed -n '/^\\*\\*Backend (NestJS)/,/^## 1\\./p' | grep -E '^\\*\\*Backend|// \\+'`,
				{ ...at, clear: true, shown: "bridge guide mechanisms | sed -n '/Backend (NestJS)/,/## 1./p' | grep -E 'Backend|// \\+'" }
			);
			expect(output).toContain('4 lines');
			expect(output).toContain("@RequireQuota('exports')");
			expect(output).toContain('BridgeModule.forRoot');
			expect(output.split('\n').filter((l) => l.includes('// +') && !l.startsWith('**')).length).toBe(4);
		});

		await step('The rule every limit follows, in one sentence: counter or gauge', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide mechanisms')} | sed -n '/^## 3. Counter or gauge/,/^| Resets/p'`, {
				...at,
				clear: true,
				shown: "bridge guide mechanisms | sed -n '/Counter or gauge/,/Resets/p'"
			});
			expect(output).toContain("If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.");
		});

		await step('The SvelteKit sign-in guide is short now: 190 lines instead of 464, and this is its whole outline', async () => {
			const { output } = await terminal(
				`${bridge(dir, 'guide svelte sdk-auth')} > guide.md; wc -l < guide.md; grep -E '^#{1,2} ' guide.md; rm guide.md`,
				{ ...at, clear: true, shown: "bridge guide svelte sdk-auth > guide.md; wc -l < guide.md; grep -E '^#{1,2} ' guide.md" }
			);
			const lines = Number(output.trim().split('\n')[0].trim());
			expect(lines).toBeGreaterThan(20);
			expect(lines).toBeLessThan(300);
		});

		let answer = '';
		await step('Asked “how do I limit tickets per plan?”, Claude Code reads Bridge’s guide and answers: tickets are a gauge, with a limit on each plan', async () => {
			const { output } = await terminal(
				`claude -p "My NestJS helpdesk backend uses Bridge. How do I limit how many tickets a workspace can have, per plan?" ` +
					`--mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__bridge ` +
					`--append-system-prompt "Answer in at most 12 short lines of plain text, no bold or headings, with one code sample of at most 8 lines." ` +
					`--output-format stream-json --verbose > run.jsonl; ` +
					`jq -r 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use" and (.name | startswith("mcp__bridge__"))) | "[called \\(.name | sub("mcp__bridge__"; "")) \\(.input.topic // "")]"' run.jsonl; ` +
					`jq -r 'select(.type=="result") | .result' run.jsonl > answer.txt; rm -f run.jsonl; awk '/^\x60\x60\x60/{exit} {print}' answer.txt`,
				{ ...at, clear: true, shown: 'claude -p "How do I limit how many tickets a workspace can have, per plan?"', timeoutMs: 300_000 }
			);
			answer = readFileSync(join(dir, 'answer.txt'), 'utf8');
			expect(output).toContain('[called get_integration_guide');
			expect(answer).toMatch(/gauge/i);
		});

		await step('…and the code: the decorator on create and on delete, each passing the app’s own count', async () => {
			const { output } = await terminal(`awk '/^\x60\x60\x60/{f=1} f{print}' answer.txt; rm -f answer.txt`, {
				...at,
				clear: true,
				shown: '# …the rest of Claude Code’s answer'
			});
			expect(answer).toContain('RequireQuota');
			expect(output.length).toBeGreaterThan(0);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await removeApp();
	}
});
