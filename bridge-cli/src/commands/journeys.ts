import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandsDir } from './runtime-dir.js';
import { outputError, outputPrompt, outputSuccess } from '../output.js';
import { cliPromptUrl } from '../prompt-urls.js';

/*
 * TBP-712 — the Bridge's seven journeys by name: `bridge guide add-login` etc.
 *
 * The same seven are prompts (client commands) on the Bridge MCP server, and
 * both surfaces compose the same content: the journey's decision guide
 * (TBP-540) or, until it is written, the framework-agnostic master that exists
 * today, then the per-framework guide. The MCP prompt steers to tools; this
 * steers to the matching `bridge …` commands.
 */

/** The seven TBP-540 decision domains a journey can open with. */
export const DECISION_DOMAINS = [
  'login', 'teams', 'roles', 'payments', 'feature-control', 'look-and-feel', 'going-live',
] as const;

export type DecisionDomain = (typeof DECISION_DOMAINS)[number];

export type Master = 'auth' | 'billing' | 'flags';

export interface Journey {
  name: string;
  title: string;
  domain: DecisionDomain | null;
  master: Master | null;
  /** Per-framework guide feature; `auth` resolves to `sdk-auth` on the frontends via guide coverage. */
  feature: 'auth' | 'billing' | 'feature-flags' | 'team' | null;
  steps: string[];
}

const PRODUCT_QUESTIONS =
  'Product questions (what to charge, who may do what, what a plan includes, what users see) belong to the ' +
  'developer: ask them and wait. Mechanics you decide, following the guide, and state the reason in one line.';

export const JOURNEYS: Journey[] = [
  {
    name: 'add-login',
    title: 'Add login',
    domain: 'login',
    master: 'auth',
    feature: 'auth',
    steps: [
      'Goal: users can sign up and sign in to this app through the Bridge.',
      'Read the current setup with `bridge app get` and `bridge auth config`.',
      'Ask the developer which sign-in methods they want before changing them; SSO is `bridge setup sso`.',
      'Register the callback URL with `bridge app redirect-uris add` (never replace the list).',
      'Prove it works at the end: `bridge test-user create`, then `bridge test-user verify`.',
    ],
  },
  {
    name: 'add-paid-plan',
    title: 'Add a paid plan',
    domain: 'payments',
    master: 'billing',
    feature: 'billing',
    steps: [
      'Goal: a customer can pick a paid plan and pay for it.',
      'Read the current plans with `bridge plan list`.',
      'Plan names, prices, trials and quotas are product decisions: ask the developer, then `bridge plan create`, `bridge plan price set`, `bridge plan quota set`.',
      'Check payments with `bridge stripe status`; `bridge stripe connect` if it is not connected.',
      'A /welcome page for new customers is an offer: suggest it, and create it only if the developer says yes.',
    ],
  },
  {
    name: 'add-feature-flag',
    title: 'Add a feature flag',
    domain: 'feature-control',
    master: 'flags',
    feature: 'feature-flags',
    steps: [
      'Goal: a feature in the app is controlled by a Bridge flag.',
      'Read the current flags with `bridge flag list`.',
      'How flags, plans, roles and limits fit together: `bridge guide fit-together`. A feature a plan sells goes on the plan (`bridge plan feature add`) and the rule points at `bridge:billing.entitlement.<feature>`; who someone is goes in a rule on a privilege, never a role check in code.',
      'Who should see the feature is the developer\'s call: ask, then `bridge flag create` with that rule.',
      'Read the flag in the app with the SDK surface the guide names, never by hand against SDK internals.',
    ],
  },
  {
    name: 'add-teams',
    title: 'Add teams',
    domain: 'teams',
    master: null,
    feature: 'team',
    steps: [
      'Goal: a customer can invite teammates into their workspace, each with a role.',
      'Read the current roles with `bridge role list`: what a role can do is only the default setup until you have read it.',
      'Which roles exist and what each may do are product decisions: ask the developer, then `bridge role create` / `bridge role update`.',
      'Wire the team UI with the SDK surface the per-framework team guide names.',
    ],
  },
  {
    name: 'go-live',
    title: 'Go live',
    domain: 'going-live',
    master: null,
    feature: null,
    steps: [
      'Goal: nothing on the readiness checklist blocks real users.',
      'Run `bridge setup status` and start from its productionNeeds. Take each item in turn with the developer: production URLs, redirect URIs and origins, the email sender (`bridge setup communication`), live Stripe keys.',
      'Finish with `bridge setup status` again and show the developer what is left.',
    ],
  },
  {
    name: 'verify-setup',
    title: 'Verify setup',
    domain: null,
    master: null,
    feature: null,
    steps: [
      'Goal: evidence that sign-in works end to end, not an opinion.',
      '1. `bridge diagnose` in the project: it reads the .env files and reports every difference with its fix.',
      '2. `bridge setup status` for the readiness checklist.',
      '3. `bridge test-user create`, then `bridge test-user verify` with its email and password.',
    ],
  },
  {
    name: 'whats-wrong',
    title: 'What is wrong',
    domain: null,
    master: null,
    feature: null,
    steps: [
      'Goal: the reason for the failure and its fix, from evidence.',
      'Someone cannot sign in: `bridge event auth-attempts` for their email; each failed attempt carries its reason and fix.',
      'The app itself misbehaves: `bridge diagnose` in the project, then `bridge setup status`.',
      'To tell a Bridge problem from an app-code problem: `bridge test-user create` and `bridge test-user verify`. If that works, the app code is the difference.',
    ],
  },
];

export function findJourney(name: string): Journey | undefined {
  return JOURNEYS.find((j) => j.name === name);
}

/**
 * THE seam for TBP-540: a decision guide is `prompts/decisions/<domain>.md`,
 * beside the masters. Read like them (dev override, then bundled), then from
 * GitHub so a CLI released before a guide was written still finds it — the
 * same path the MCP server reads. Null means not written yet.
 */
export async function fetchDecisionGuide(domain: DecisionDomain): Promise<string | null> {
  const filename = `${domain}.md`;
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  const candidates = [
    ...(localDir ? [join(localDir, 'bridge-cli', 'bridge-cli', 'prompts', 'decisions', filename)] : []),
    join(commandsDir, '..', 'prompts', 'decisions', filename),
    join(commandsDir, '..', '..', 'prompts', 'decisions', filename),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      /* try next */
    }
  }
  try {
    const res = await fetch(cliPromptUrl('decisions', filename));
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** The pieces a journey is built from, injected so the composition is testable without a network. */
export interface JourneySources {
  decision: (domain: DecisionDomain) => Promise<string | null>;
  master: (master: Master) => Promise<string>;
  frameworkGuide: (framework: string, feature: string) => Promise<string>;
  /** Which feature stems exist per framework (guide-coverage.json). */
  coverage: () => Record<string, string[]>;
}

export interface ComposedJourney {
  journey: string;
  framework: string | null;
  /** 'decision' once TBP-540's guide exists; 'master' or 'none' until then. */
  opensWith: 'decision' | 'master' | 'none';
  guide: string;
}

export async function composeJourney(
  journey: Journey,
  framework: string | null,
  sources: JourneySources,
): Promise<ComposedJourney> {
  const header = [`# ${journey.title} — a Bridge journey`, '', ...journey.steps, '', PRODUCT_QUESTIONS, ''];
  if (journey.feature) {
    header.push(
      framework
        ? `Framework: ${framework}.`
        : 'Framework not detected from package.json: re-run with `--framework <name>` ' +
            '(svelte, react, angular, nextjs, nestjs, express) to include the per-framework guide, or ask the developer.',
    );
  }
  header.push(`In an MCP client the same journey is the \`${journey.name}\` prompt of the Bridge server.`);

  const sections = [header.join('\n')];
  let opensWith: ComposedJourney['opensWith'] = 'none';

  if (journey.domain) {
    const decision = await sources.decision(journey.domain);
    if (decision) {
      sections.push(decision);
      opensWith = 'decision';
    } else if (journey.master) {
      sections.push(
        `(The decision guide for ${journey.domain} is not written yet; this is the closest existing guide.)\n\n` +
          (await sources.master(journey.master)),
      );
      opensWith = 'master';
    } else {
      sections.push(
        `(The decision guide for ${journey.domain} is not written yet, and no framework-agnostic guide covers it. ` +
          'Work from the steps above, and take every product decision to the developer.)',
      );
    }
  }

  if (journey.feature && framework) {
    const features = sources.coverage()[framework] ?? [];
    const feature = journey.feature === 'auth' && features.includes('sdk-auth') ? 'sdk-auth' : journey.feature;
    sections.push(await sources.frameworkGuide(framework, feature));
  }

  return { journey: journey.name, framework, opensWith, guide: sections.join('\n\n---\n\n') };
}

/** The message for `bridge guide <name>` when nothing matches: names what does. */
export function unknownGuideMessage(name: string, frameworks: string[]): string {
  return (
    `No guide named '${name}'. Journeys: ${JOURNEYS.map((j) => j.name).join(', ')}. ` +
    `Frameworks: ${frameworks.join(', ')} (e.g. \`bridge guide svelte auth\`). ` +
    'Also: orientation (what Bridge does), fit-together (how roles, plans, limits and flags fit together), ' +
    'decision <domain>, flags, billing, mechanisms, custom, list. ' +
    '`bridge guide` alone prints the integration master.'
  );
}

export function registerJourneyCommands(
  guide: Command,
  sources: JourneySources,
  detectFramework: (override: string | undefined, cwd: string) => Promise<string | undefined>,
): void {
  for (const journey of JOURNEYS) {
    const cmd = guide
      .command(journey.name)
      .description(`Journey: ${journey.title.toLowerCase()} (the same as the Bridge MCP prompt)`)
      .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt');
    if (journey.feature) {
      cmd
        .option('--framework <name>', 'svelte | react | angular | nextjs | nestjs | express (auto-detected from package.json when omitted)')
        .option('--cwd <path>', 'Project dir used for framework detection', process.cwd());
    }
    cmd.action(async (_opts, command: Command) => {
      try {
        const opts = command.optsWithGlobals() as { framework?: string; cwd?: string; json?: boolean };
        const framework = journey.feature
          ? (await detectFramework(opts.framework, opts.cwd ?? process.cwd())) ?? null
          : null;
        const composed = await composeJourney(journey, framework, sources);
        if (opts.json) outputSuccess(composed);
        else outputPrompt(composed.guide);
      } catch (err) {
        outputError(err);
      }
    });
  }
}
