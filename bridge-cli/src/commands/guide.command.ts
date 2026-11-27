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
 */

const BASE = 'https://raw.githubusercontent.com/thebridgedev';
const CLI_REPO = 'bridge-cli/main';
const FRAMEWORKS: Record<string, string> = {
  svelte: 'bridge-svelte/main',
  react: 'bridge-react/main',
  angular: 'bridge-angular/main',
  nextjs: 'bridge-nextjs/main',
  nestjs: 'bridge-nestjs/main',
  express: 'bridge-express/main',
};
/** A feature a framework has a guide for, and the files that may hold it, in order. */
const FEATURES: Record<string, readonly string[]> = {
  integration: ['mcp/integration-prompt.md'],
  auth: ['mcp/sdk-auth-prompt.md', 'mcp/auth-prompt.md'],
  'feature-flags': ['mcp/feature-flags-prompt.md'],
  billing: ['mcp/billing-prompt.md'],
  team: ['mcp/team-prompt.md'],
  branding: ['mcp/branding-prompt.md'],
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
  'mcp-and-cli': 'bridge-cli/prompts/mcp-and-cli.md',
};
const DECISIONS = ['login', 'teams', 'roles', 'payments', 'feature-control', 'look-and-feel', 'going-live'] as const;
/** The master that stands in for a decision guide not written yet. */
const STAND_IN: Record<string, string | undefined> = { login: 'master', payments: 'billing-master', 'feature-control': 'flags-master' };

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
      'Ask the developer which sign-in methods they want (password, magic link, passkeys, Google, LinkedIn, Microsoft, GitHub, Facebook) before changing any: `bridge auth methods enable|disable <method>`. A social provider needs its client ID and secret first: `bridge auth providers set <provider> --client-id <id> --client-secret <secret> --enable` prints the return address to register with the provider (Microsoft also takes `--who-can-sign-in any|work|personal|directory`). Password rules are presets or custom rules (`bridge auth password-policy --preset recommended`); token lifetimes are `bridge auth token-lifetime`. Apple is not available on Bridge yet.',
      "Register the app's sign-in return and the pages it runs on: `bridge app address add <url> --use sign-in-return`.",
      'Prove it works at the end by signing up and signing in yourself in the running app.',
    ],
  },
  {
    name: 'add-paid-plan',
    decision: 'payments',
    feature: 'billing',
    steps: [
      'Goal: a customer can pick a paid plan and pay for it.',
      'Plan names, prices, trials and limits are product decisions: ask the developer, then `bridge plan create <key> --name <name> --price "<amount> <CURRENCY>/<interval>" --trial-days <n> | --no-trial`.',
      'Check payments with `bridge stripe status`; `bridge stripe connect` connects it.',
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
    ],
  },
  {
    name: 'add-teams',
    decision: 'teams',
    feature: 'team',
    steps: [
      'Goal: a customer can invite teammates into their workspace, each with a role.',
      'Which roles exist and what each may do are product decisions: ask the developer, then `bridge role create <key> --name <name> --privilege <p>`.',
      'Wire the team UI with the SDK surface the per-framework team guide names.',
    ],
  },
  {
    name: 'go-live',
    decision: 'going-live',
    feature: null,
    steps: [
      'Goal: nothing on the readiness checklist blocks real users.',
      'Take each item in turn with the developer: production addresses (`bridge app address list`), the email sender (`bridge setup communication`), live Stripe keys (`bridge stripe connect --live`).',
    ],
  },
  {
    name: 'verify-setup',
    decision: null,
    feature: null,
    steps: ['Goal: evidence that sign-in works end to end, not an opinion.', '1. `bridge app get` and `bridge auth config`: compare them with the project\'s Bridge settings.', '2. Ask the developer to sign up and sign in themselves in the running app.'],
  },
  {
    name: 'whats-wrong',
    decision: null,
    feature: null,
    steps: ['Goal: the reason for the failure and its fix, from evidence.', '`bridge event list --since 24h` shows what happened; `bridge auth config` how sign-in is set up.'],
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

async function frameworkGuide(ctx: Context, framework: string, feature: string): Promise<string | null> {
  const repo = FRAMEWORKS[framework];
  if (repo === undefined) throw new CliError('invalid', `${framework} is not a framework Bridge ships an SDK for: ${Object.keys(FRAMEWORKS).join(', ')}.`);
  for (const path of FEATURES[feature] ?? []) {
    const found = await read(ctx, `${BASE}/${repo}/${path}`);
    if (found !== null) return found;
  }
  return null;
}

async function master(ctx: Context, topic: string): Promise<string> {
  const path = MASTERS[topic] as string;
  return (await read(ctx, `${BASE}/${CLI_REPO}/${path}`)) ?? `# The ${topic} guide is unavailable\n\nNo file at ${BASE}/${CLI_REPO}/${path}.`;
}

async function decisionGuide(ctx: Context, domain: string): Promise<string> {
  const found = await read(ctx, `${BASE}/${CLI_REPO}/bridge-cli/prompts/decisions/${domain}.md`);
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
        const coverage = await read(ctx, `${BASE}/${CLI_REPO}/bridge-cli/prompts/guide-coverage.json`);
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
        });
      }),
    );

  for (const topic of ['flags', 'billing'] as const) {
    guide
      .command(topic)
      .description(`The ${topic === 'flags' ? 'feature flags' : 'billing'} integration prompt (with --framework, that framework's guide)`)
      .option('--framework <name>', `One of: ${Object.keys(FRAMEWORKS).join(', ')}`)
      .option('--json', 'Give a JSON envelope instead of the markdown')
      .action(
        action(deps, async (ctx, opts: { framework?: string; json?: boolean }) => {
          const text = opts.framework === undefined ? await master(ctx, `${topic}-master`) : await frameworkGuide(ctx, opts.framework, topic === 'flags' ? 'feature-flags' : 'billing');
          if (text === null) throw new CliError('not-found', `There is no ${topic} guide for ${opts.framework ?? ''} yet.`, { hint: '`bridge guide list` shows which guides exist per framework.' });
          emit(ctx, topic, text, opts.json);
        }),
      );
  }
  for (const topic of ['mechanisms', 'orientation', 'fit-together', 'integration-success', 'mcp-and-cli'] as const) {
    guide
      .command(topic)
      .description({ mechanisms: 'How Bridge works: limits, counters and gauges, UI levels, customisation', orientation: 'What Bridge does: a short map to relay to a developer', 'fit-together': 'How roles, plans, limits and flags fit together', 'integration-success': 'The message to give at the end of a finished integration', 'mcp-and-cli': "Protect your app's MCP endpoint and sign users in to your own CLI" }[topic])
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
  for (const framework of Object.keys(FRAMEWORKS)) {
    guide
      .command(framework)
      .argument('[feature]', `One of: ${Object.keys(FEATURES).join(', ')} (default integration)`)
      .description(`The integration guide for ${framework}`)
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
      .option('--framework <name>', `One of: ${Object.keys(FRAMEWORKS).join(', ')}`)
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
