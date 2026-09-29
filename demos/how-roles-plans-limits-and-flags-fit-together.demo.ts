import { test, expect } from '../demo-kit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-705 (milestone TBP-M35): one guide, "How roles, plans, limits and
 * flags fit together", that every other guide points to, printed by the
 * command line and served by the MCP server.
 *
 * The guide opens with the owner's best-practice sentence (TBP-705 note,
 * 2026-09-28) verbatim: features are controlled with flags; a plan that sells
 * a feature also lists it, and the flag's rule points at that list. It then
 * says which tool answers which question, where a flag is not the tool
 * (numbers are plan limits; permission on one record stays in app code), and
 * that access by who someone is goes through a flag rule on a privilege,
 * never a hard-coded role check. Every decision guide, the orientation map
 * and the mechanisms page point to it. A connected agent reads the same text
 * with `get_integration_guide topic=fit-together`, and the flag tools carry
 * the one-line rule.
 *
 * The CLI is the published beta, in a container. A read-only API token for a
 * throwaway stage app is used for the MCP calls (masked); the app is deleted
 * at the end.
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-M35 bridge-plugins/bridge-cli/demos/how-roles-plans-limits-and-flags-fit-together.demo.ts \
 *     --title "16 · TBP-705 · How roles, plans, limits and flags fit together"
 */

const STAGE = 'https://api-stage.thebridge.dev';
const API_DIR = process.env.DEMO_BRIDGE_API_DIR ?? '/Users/imanpouya/code/nebulr/thebridge-platform/bridge-api';
const CLI_VERSION = process.env.DEMO_CLI_VERSION ?? '0.6.0-beta.7';
const DOMAIN = 'demo-fit-together';
const OWNER_SENTENCE = 'Features should be controlled with feature flags.';

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

/** Terminal output wraps long lines; assertions read it as one run of text. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

const CLI = `npx -y @nebulr-group/bridge-cli@${CLI_VERSION}`;

/** Runs a shell snippet in one throwaway node:22 container, where `bridge` is the published CLI. */
function inCli(dir: string, script: string): string {
	return (
		`docker run --rm -v "${dir}":/w -w /w -e BRIDGE_BASE_URL=${STAGE} -e BRIDGE_NO_BANNER=true ` +
		`-e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error node:22 sh -c '${script.replace(/'/g, `'"'"'`)}'`
	);
}
const bridge = (dir: string, args: string) => inCli(dir, `${CLI} ${args}`);

/** A tools/call (or any method) over plain JSON-RPC, as an MCP client sends it; jq renders the answer. */
const mcp = (method: string, params: Record<string, unknown>, jq: string) =>
	`curl -s ${STAGE}/mcp -H "Authorization: Bearer $BRIDGE_API_KEY" -H 'content-type: application/json' ` +
	`-H 'accept: application/json, text/event-stream' ` +
	`-d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}' | jq -r ${jq}`;

test('How roles, plans, limits and flags fit together, in one guide every other guide points to', async ({ demo }) => {
	test.setTimeout(10 * 60 * 1000);
	const { step, terminal } = demo;

	await removeApp();
	await post('setup-test-app', { domain: DOMAIN, appName: 'Helpdesk', ownerEmail: `${DOMAIN}@example.com`, appUrl: 'http://localhost:5173' });
	const { token } = await post<{ token: string }>('generate-jwt', { appDomain: DOMAIN, privileges: ['AUTHENTICATED', 'USER_READ', 'TENANT_READ'] });

	const dir = mkdtempSync(join(tmpdir(), 'helpdesk-'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'helpdesk', private: true }, null, 2));
	const at = { cwd: dir, promptDir: 'helpdesk', title: 'helpdesk — the Bridge command line', env: { BRIDGE_API_KEY: token }, redact: [token], timeoutMs: 240_000 };

	// Wake the stage Lambda before the first MCP call.
	await fetch(`${STAGE}/mcp`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
	}).catch(() => undefined);

	try {
		await step('One command prints the guide. It opens with the rule, in the owner’s own words', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide fit-together')} | sed -n '1,/^## One question/p' | sed '$d' | fold -s -w 118`, {
				...at,
				clear: true,
				shown: 'bridge guide fit-together'
			});
			expect(flat(output)).toContain('# How roles, plans, limits and flags fit together');
			expect(flat(output)).toContain(OWNER_SENTENCE);
			expect(flat(output)).toContain('If a plan sells the feature, include it on the plan as well.');
			expect(flat(output)).toContain('changing what Pro includes is one edit in one place');
		});

		await step('Then one question, one tool: a flag for on or off, the plan’s feature list for what it sells, a limit for numbers, a privilege for who', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide fit-together')} | sed -n '/^## One question/,/^## Where a flag/p' | sed '$d' | fold -s -w 118`, {
				...at,
				clear: true,
				shown: "bridge guide fit-together | sed -n '/One question/,/Where a flag/p'"
			});
			expect(flat(output)).toContain('a **flag**');
			expect(flat(output)).toContain('bridge:billing.entitlement.analytics eq true');
			expect(flat(output)).toContain('a **plan limit**');
			expect(flat(output)).toMatch(/privilege\*\* \(preferred\)/);
			expect(flat(output)).toContain("The flag's rule never names plans.");
		});

		await step('Where a flag is not the tool: numbers are plan limits, and permission on one specific record stays in the app', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide fit-together')} | sed -n '/^## Where a flag/,/^## Access by/p' | sed '$d' | fold -s -w 118`, {
				...at,
				clear: true,
				shown: "bridge guide fit-together | sed -n '/Where a flag is not the tool/,/Access by/p'"
			});
			expect(flat(output)).toContain('**Numbers are plan limits.**');
			expect(flat(output)).toContain('**Permission on one specific record stays in app code.**');
			expect(flat(output)).toContain('**Checking a plan feature without a flag is the exception.**');
		});

		await step('Access by who someone is: a flag rule on a privilege, never a role check written into the code. Roles are only ever “the default setup”', async () => {
			const { output } = await terminal(`${bridge(dir, 'guide fit-together')} | sed -n '/^## Access by/,/^## The backend/p' | sed '$d' | fold -s -w 118`, {
				...at,
				clear: true,
				shown: "bridge guide fit-together | sed -n '/Access by who someone is/,/The backend/p'"
			});
			expect(flat(output)).toContain('never with a role check written into the app');
			expect(flat(output)).toContain('**Prefer a privilege rule**');
			expect(flat(output)).toContain('**An admin-only page is a flag route rule, not a check on the page.**');
			expect(flat(output)).toContain('in the default setup');
		});

		await step('Every other guide points to it: the seven decision guides, the orientation map and the mechanisms page', async () => {
			const areas = ['login', 'teams', 'roles', 'payments', 'feature-control', 'look-and-feel', 'going-live'];
			const script =
				`for d in ${areas.join(' ')}; do ${CLI} guide decision $d | grep -q fit-together && echo "bridge guide decision $d  → points to fit-together"; done; ` +
				`for g in orientation mechanisms; do ${CLI} guide $g | grep -q fit-together && echo "bridge guide $g  → points to fit-together"; done`;
			const { output } = await terminal(`${inCli(dir, script)} | column -t -s '→' `, {
				...at,
				clear: true,
				shown: 'for g in <every guide>; do bridge guide $g | grep fit-together; done'
			});
			for (const area of areas) expect(flat(output)).toContain(`bridge guide decision ${area}`);
			expect(flat(output)).toContain('bridge guide orientation');
			expect(flat(output)).toContain('bridge guide mechanisms');
		});

		await step('A connected agent reads the same guide from Bridge’s MCP server, opening with the same rule', async () => {
			const { output } = await terminal(
				mcp('tools/call', { name: 'get_integration_guide', arguments: { topic: 'fit-together' } }, `'.result.content[0].text | fromjson | .data.markdown' | sed -n '1,/^## One question/p' | sed '$d' | fold -s -w 118`),
				{ ...at, clear: true, shown: 'claude  ›  get_integration_guide { topic: "fit-together" }' }
			);
			expect(flat(output)).toContain('# How roles, plans, limits and flags fit together');
			expect(flat(output)).toContain(OWNER_SENTENCE);
		});

		await step('And the tools an agent uses to set up flags carry the rule, and send it to that guide before it starts', async () => {
			const { output } = await terminal(
				mcp('tools/list', {}, `'.result.tools[] | select(.name == "create_feature_flag") | .description' | grep -oE 'Flags are the standard way.*topic=fit-together\\.' | fold -s -w 118`),
				{ ...at, clear: true, shown: 'claude  ›  tools/list   # the create_feature_flag description' }
			);
			expect(flat(output)).toContain('get_integration_guide topic=fit-together');
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await removeApp();
	}
});
