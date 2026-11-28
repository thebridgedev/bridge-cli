import type { Command } from 'commander';
import { CliError } from '../core/errors.js';
import { call } from '../core/http.js';
import { action, type Context, type Deps } from './context.js';

/**
 * The integration guides: what to read before wiring Bridge into app code. They live in Bridge's public repositories
 * and are read from there, the way Bridge's MCP server reads them, so the CLI, the assistant and the docs never differ.
 * `bridge guide` prints the master prompt; `bridge guide <topic>` one guide; the journeys (`add-login`, `add-paid-plan`,
 * `add-feature-flag`, `add-teams`, `go-live`, `verify-setup`, `whats-wrong`) the same instructions the assistant's
 * commands give, from a terminal.
 *
 * This is CLI 1.0, for the new Bridge: it reads the guides of the 1.0 line, each repository's `v1` branch, and never
 * falls back to the 0.x text on `main` (CLI 0.x keeps reading that). A framework with no 1.0 plugin gets a plain note
 * instead of its 0.x guide.
 */

const DEFAULT_BASE = 'https://raw.githubusercontent.com/thebridgedev';
/** Where the guides are read from: `BRIDGE_GUIDES_BASE_URL` (a local copy laid out as `<repo>/<branch>/<path>`), else GitHub. */
const baseOf = (ctx: Context): string => {
  const given = ctx.deps.env['BRIDGE_GUIDES_BASE_URL']?.trim();
  return given === undefined || given === '' ? DEFAULT_BASE : given.replace(/\/+$/, '');
};
const CLI_REPO = 'bridge-cli/v1';
/** The frameworks with a 1.0 plugin, and the line their guides are on. `javascript` is auth-core, for any other JavaScript app. */
const FRAMEWORKS: Record<string, string> = {
  svelte: 'bridge-svelte/v1',
  nestjs: 'bridge-nestjs/v1',
  javascript: 'auth-core/v1',
};
/** The frameworks Bridge has a 0.x plugin for and no 1.0 plugin yet. */
const NOT_YET: readonly string[] = ['react', 'angular', 'nextjs', 'express'];
const ALL_FRAMEWORKS = [...Object.keys(FRAMEWORKS), ...NOT_YET];
/** A feature a framework has a guide for, and the files that may hold it, in order. */
const FEATURES: Record<string, readonly string[]> = {
  integration: ['mcp/integration-prompt.md'],
  auth: ['mcp/sdk-auth-prompt.md', 'mcp/auth-prompt.md'],
  'sdk-auth': ['mcp/sdk-auth-prompt.md'],
  'feature-flags': ['mcp/feature-flags-prompt.md'],
  billing: ['mcp/billing-prompt.md'],
  team: ['mcp/team-prompt.md'],
  branding: ['mcp/branding-prompt.md'],
  server: ['mcp/server-prompt.md'],
};
/** The guides every framework shares, in the CLI repository. */
const MASTERS: Record<string, string> = {
  master: 'bridge-cli/prompts/auth-master-integration-prompt.md',
  'flags-master': 'bridge-cli/prompts/flags/master.md',
  'billing-master': 'bridge-cli/prompts/billing/master.md',
  mechanisms: 'bridge-cli/prompts/mechanisms.md',
  orientation: 'bridge-cli/prompts/orientation.md',
  'fit-together': 'bridge-cli/prompts/fit-together.md',
  'integration-success': 'bridge-cli/prompts/integration-success.md',
};
const DECISIONS = ['login', 'teams', 'roles', 'payments', 'feature-control', 'look-and-feel', 'going-live'] as const;
/** The master that stands in for a decision guide not written yet. */
const STAND_IN: Record<string, string | undefined> = { login: 'master', payments: 'billing-master', 'feature-control': 'flags-master' };

/** What a framework with no 1.0 plugin gets instead of its 0.x guide. */
export function noPluginYet(framework: string): string {
  return [
    `# ${framework} has no 1.0 plugin yet`,
    '',
    `The new Bridge works with the 1.0 plugins only, and there is no 1.0 plugin for ${framework} yet. Its 0.x plugin talks to the old Bridge and does not work here, so this guide is not given: tell the developer before building on it.`,
    '',
    'What to use instead:',
    '',
    '- **Any JavaScript app:** `@nebulr-group/bridge-auth-core@alpha`, `createBridge({ issuer })` in the browser and `createBridgeServer({ issuer, appKey })` on a server. `bridge guide javascript` and `bridge guide javascript server` are its guides.',
    '- **SvelteKit:** `bridge guide svelte`. **NestJS:** `bridge guide nestjs`.',
  ].join('\n');
}

/** The verify rule: what any assistant can check from a terminal, and what needs a browser. */
const VERIFY_INTRO = 'Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.';

interface Journey {
  readonly name: string;
  readonly decision: (typeof DECISIONS)[number] | null;
  readonly feature: string | null;
  readonly steps: readonly string[];
}

const JOURNEYS: readonly Journey[] = [
  {
    name: 'add-login',
    decision: 'login',
    feature: 'auth',
    steps: [
      'Goal: users can sign up and sign in to this app through the Bridge.',
      "Sign-in happens inside the app, on its own `/auth` pages, styled to match it. Install the 1.0 plugin from the `alpha` tag; its one setting is the app's issuer.",
      "Hook the project up: `bridge app setup --url <dev address>` writes the issuer into `.env` and adds the address as a browser origin and `<address>/auth` as the email-links address. Production addresses: `bridge app address add <url> --use browser-origin` and `bridge app address add <url>/auth --use email-links`.",
      'Ask the developer which sign-in methods they want before changing any. Password, sign-in links and passkeys: `bridge auth methods enable|disable <magicLink|passkeys|password>`. Social providers and the second step (a code by text message) are switched on in the dashboard, where their credentials are saved.',
      'Prove it works by asking the developer to sign up and sign in themselves in the running app (sign-up, the email link, sign-in, sign-out). If a step fails, `bridge event auth-attempts --user <their email>` names the reason and the fix.',
    ],
  },
  {
    name: 'add-paid-plan',
    decision: 'payments',
    feature: 'billing',
    steps: [
      'Goal: a customer can pick a paid plan and pay for it.',
      'Plan names, prices, trials and limits are product decisions: ask the developer, then `bridge plan create <key> --name <name> --price "<amount> <CURRENCY>/<interval>" --trial-days <n>` (or `--no-trial`).',
      'Check payments with `bridge stripe status`; `bridge stripe connect` connects Stripe in test mode.',
      'Verify. ' + VERIFY_INTRO,
      'Terminal checks: the project builds; `npx @nebulr-group/bridge-cli@alpha check gates` is clean; `bridge plan list` shows the plans, prices, trials, features and limits the developer confirmed; `bridge stripe status` says Stripe is connected; with a backend, a call to the counted handler at the limit is refused with 402.',
      'Browser checks: 1. the plan page shows the plans, a plan with a monthly and a yearly price as one card; 2. choosing the free plan changes the plan at once; 3. a paid plan opens Stripe Checkout; 4. a test payment returns to the plan page on the new plan, and a cancelled one returns too; 5. a workspace with no plan lands on the plan page (the paywall).',
      'When a check was not run, the summary starts with "Heads up: not verified in a browser" and names the checks, instead of the success banner.',
    ],
  },
  {
    name: 'add-feature-flag',
    decision: 'feature-control',
    feature: 'feature-flags',
    steps: [
      'Goal: a feature in the app is controlled by a Bridge flag.',
      "Who should see the feature (everyone, a share, a plan, named workspaces) is the developer's call: ask, then `bridge flag create <key> --when \"<attribute> <operator> <value>\"`.",
      'Read the flag in the app with the SDK surface the guide names, never by hand against SDK internals.',
      'Verify. ' + VERIFY_INTRO,
      'Terminal checks: the project builds; `npx @nebulr-group/bridge-cli@alpha check gates` is clean; `bridge flag get <key>` shows the rule the developer asked for; `bridge flag eval <key> --context <json>` gives the on value for someone it should match and the off value for someone it should not; with a backend, the gated endpoint answers 403 or 402 for a caller the flag is off for.',
      'Browser checks: 1. signed in as someone the flag is on for, the gated page, link or button shows; 2. as someone it is off for, it is hidden, and a gated page sends them away; 3. switching the flag off with `bridge flag off <key>` hides it within seconds, without a reload.',
      'When a check was not run, the summary starts with "Heads up: not verified in a browser" and names the checks, instead of the success banner.',
    ],
  },
  {
    name: 'add-teams',
    decision: 'teams',
    feature: 'team',
    steps: [
      'Goal: a customer can invite teammates into their workspace, each with a role.',
      'Which roles exist and what each may do are product decisions: ask the developer, then `bridge role create <key> --name <name> --privilege <p>`.',
      "Invites are emailed to the app's email-links address: check `bridge app address list` has one.",
      'Wire the team UI with the SDK surface the per-framework team guide names.',
    ],
  },
  {
    name: 'go-live',
    decision: 'going-live',
    feature: null,
    steps: [
      'Goal: nothing on the readiness checklist blocks real users.',
      'Start from `bridge setup status`. Take each item in turn with the developer: production addresses (`bridge app address list`, `bridge app address add`), the email sender (`bridge setup communication`), live Stripe keys (`bridge stripe connect --live`).',
    ],
  },
  {
    name: 'verify-setup',
    decision: null,
    feature: null,
    steps: [
      'Goal: evidence that sign-in works end to end, not an opinion.',
      VERIFY_INTRO,
      "Terminal checks: 1. `bridge doctor` compares the project's Bridge settings with the app and names every difference with its fix; fix each. 2. `bridge app address list` has the app's browser origin and email-links address. 3. `bridge setup status` for the readiness checklist. 4. `npx @nebulr-group/bridge-cli@alpha check gates` is clean.",
      'Browser checks, which are the developer\'s own: 1. sign up in the running app; 2. open the email link; 3. sign in; 4. sign out. If a step fails, `bridge event auth-attempts --user <their email>` gives the reason and the fix.',
    ],
  },
  {
    name: 'whats-wrong',
    decision: null,
    feature: null,
    steps: ['Goal: the reason for the failure and its fix, from evidence.', '`bridge event list --since 24h` shows what happened; `bridge event auth-attempts --user <email>` one person\'s sign-ins; `bridge doctor` the project against the app; `bridge auth config` how sign-in is set up.'],
  },
];

const QUESTIONS = "Product questions (what to charge, who may do what, what a plan includes, what users see) belong to the developer: ask them and wait. Mechanics (which command, which SDK surface, which setting) you decide, following the guide, and state the reason in one line.";

async function read(ctx: Context, url: string): Promise<string | null> {
  try {
    return String((await call<string>(ctx.deps.fetch, { method: 'GET', url, headers: { accept: 'text/plain' } })).body);
  } catch (error) {
    if (error instanceof CliError && error.kind === 'not-found') return null;
    const hint = "The guides are read from Bridge's public repositories, so they need the network. Retry, or read them at https://thebridge.dev.";
    if (error instanceof CliError) throw new CliError(error.kind, error.message, { ...(error.status === undefined ? {} : { status: error.status }), hint });
    throw new CliError('unavailable', `Could not read the guide at ${url}: ${error instanceof Error ? error.message : String(error)}`, { hint });
  }
}

/** A framework's guide from its 1.0 line, the no-plugin note for a framework without one, or null when it has no such guide. */
async function frameworkGuide(ctx: Context, framework: string, feature: string): Promise<string | null> {
  if (NOT_YET.includes(framework)) return noPluginYet(framework);
  const repo = FRAMEWORKS[framework];
  if (repo === undefined) throw new CliError('invalid', `${framework} is not a framework Bridge has a plugin for: ${ALL_FRAMEWORKS.join(', ')}.`);
  for (const path of FEATURES[feature] ?? []) {
    const found = await read(ctx, `${baseOf(ctx)}/${repo}/${path}`);
    if (found !== null) return found;
  }
  return null;
}

async function master(ctx: Context, topic: string): Promise<string> {
  const path = MASTERS[topic] as string;
  return (await read(ctx, `${baseOf(ctx)}/${CLI_REPO}/${path}`)) ?? `# The ${topic} guide is unavailable\n\nNo file at ${baseOf(ctx)}/${CLI_REPO}/${path}.`;
}

async function decisionGuide(ctx: Context, domain: string): Promise<string> {
  const found = await read(ctx, `${baseOf(ctx)}/${CLI_REPO}/bridge-cli/prompts/decisions/${domain}.md`);
  if (found !== null) return found;
  const standIn = STAND_IN[domain];
  const note = `# Decision guide: ${domain}: not written yet\n\nIt will appear here without a CLI change.\n\nTake every product decision to the developer rather than choosing for them.`;
  return standIn === undefined ? note : `${note}\n\nUntil then, the closest guide is the ${standIn} master:\n\n---\n\n${await master(ctx, standIn)}`;
}

export function registerGuideCommands(program: Command, deps: Deps): void {
  const emit = (ctx: Context, topic: string, markdown: string, given: boolean | undefined): void => {
    // `--json` is on `guide` and on each guide: whichever was typed.
    const json = given ?? (ctx.options as { json?: boolean }).json;
    if (json) ctx.io.result({ topic, markdown });
    else ctx.io.text(markdown);
  };
  const guide = program
    .command('guide')
    .description('Integration guides: run with no arguments for the master integration prompt')
    .option('--json', 'Give a JSON envelope instead of the markdown')
    .allowExcessArguments(false)
    .action(action(deps, async (ctx, opts: { json?: boolean }) => emit(ctx, 'master', await master(ctx, 'master'), opts.json)));

  guide
    .command('list')
    .description('The guides there are, and which features each framework has a guide for')
    .action(
      action(deps, async (ctx) => {
        const coverage = await read(ctx, `${baseOf(ctx)}/${CLI_REPO}/bridge-cli/prompts/guide-coverage.json`);
        let frameworks: unknown = null;
        try {
          frameworks = coverage === null ? null : (JSON.parse(coverage) as { frameworks?: unknown }).frameworks;
        } catch {
          frameworks = null;
        }
        ctx.io.result({
          journeys: JOURNEYS.map((each) => each.name),
          decisions: DECISIONS,
          shared: Object.keys(MASTERS),
          features: Object.keys(FEATURES),
          frameworks: frameworks ?? Object.keys(FRAMEWORKS),
          noPluginYet: NOT_YET,
        });
      }),
    );

  for (const topic of ['flags', 'billing'] as const) {
    guide
      .command(topic)
      .description(`The ${topic === 'flags' ? 'feature flags' : 'billing'} integration prompt (with --framework, that framework's guide)`)
      .option('--framework <name>', `One of: ${ALL_FRAMEWORKS.join(', ')}`)
      .option('--json', 'Give a JSON envelope instead of the markdown')
      .action(
        action(deps, async (ctx, opts: { framework?: string; json?: boolean }) => {
          const text = opts.framework === undefined ? await master(ctx, `${topic}-master`) : await frameworkGuide(ctx, opts.framework, topic === 'flags' ? 'feature-flags' : 'billing');
          if (text === null) throw new CliError('not-found', `There is no ${topic} guide for ${opts.framework ?? ''} yet.`, { hint: '`bridge guide list` shows which guides exist per framework.' });
          emit(ctx, topic, text, opts.json);
        }),
      );
  }
  for (const topic of ['mechanisms', 'orientation', 'fit-together', 'integration-success'] as const) {
    guide
      .command(topic)
      .description({ mechanisms: 'How Bridge works: limits, counters and gauges, UI levels, customisation', orientation: 'What Bridge does: a short map to relay to a developer', 'fit-together': 'How roles, plans, limits and flags fit together', 'integration-success': 'The message to give at the end of a finished integration' }[topic])
      .option('--json', 'Give a JSON envelope instead of the markdown')
      .action(action(deps, async (ctx, opts: { json?: boolean }) => emit(ctx, topic, await master(ctx, topic), opts.json)));
  }
  guide
    .command('decision <domain>')
    .description(`A decision guide: the questions to ask the developer and the defaults to apply. One of: ${DECISIONS.join(', ')}`)
    .option('--json', 'Give a JSON envelope instead of the markdown')
    .action(
      action(deps, async (ctx, domain: string, opts: { json?: boolean }) => {
        if (!(DECISIONS as readonly string[]).includes(domain)) throw new CliError('invalid', `${domain} is not a decision domain: ${DECISIONS.join(', ')}.`);
        emit(ctx, `decision:${domain}`, await decisionGuide(ctx, domain), opts.json);
      }),
    );
  for (const framework of ALL_FRAMEWORKS) {
    guide
      .command(framework)
      .argument('[feature]', `One of: ${Object.keys(FEATURES).join(', ')} (default integration)`)
      .description(NOT_YET.includes(framework) ? `${framework} has no 1.0 plugin yet: says what to use instead` : framework === 'javascript' ? 'The integration guide for any other JavaScript app (auth-core): integration, or server' : `The integration guide for ${framework}`)
      .option('--json', 'Give a JSON envelope instead of the markdown')
      .action(
        action(deps, async (ctx, feature: string | undefined, opts: { json?: boolean }) => {
          const wanted = feature ?? 'integration';
          if (!(wanted in FEATURES)) throw new CliError('invalid', `${wanted} is not a feature: ${Object.keys(FEATURES).join(', ')}.`);
          const text = await frameworkGuide(ctx, framework, wanted);
          if (text === null) throw new CliError('not-found', `There is no ${wanted} guide for ${framework} yet.`, { hint: '`bridge guide list` shows which guides exist per framework.' });
          emit(ctx, `${framework}:${wanted}`, text, opts.json);
        }),
      );
  }
  for (const journey of JOURNEYS) {
    guide
      .command(journey.name)
      .description(`The ${journey.name} journey: its steps, its decision guide and, with --framework, that framework's guide`)
      .option('--framework <name>', `One of: ${ALL_FRAMEWORKS.join(', ')}`)
      .option('--json', 'Give a JSON envelope instead of the markdown')
      .action(
        action(deps, async (ctx, opts: { framework?: string; json?: boolean }) => {
          const parts = [`# ${journey.name} — a Bridge journey`, '', ...journey.steps, '', QUESTIONS];
          if (journey.decision !== null) parts.push('', `## Decision guide: ${journey.decision}`, '', await decisionGuide(ctx, journey.decision));
          if (opts.framework !== undefined && journey.feature !== null) {
            const text = await frameworkGuide(ctx, opts.framework, journey.feature);
            parts.push('', text === null ? `## No ${journey.feature} guide for ${opts.framework}\n\n\`bridge guide list\` shows which guides exist.` : `## ${opts.framework} ${journey.feature} guide\n\n${text}`);
          }
          emit(ctx, journey.name, parts.join('\n'), opts.json);
        }),
      );
  }
}
