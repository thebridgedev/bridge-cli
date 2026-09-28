/**
 * TBP-706 — every `bridge …` command the bundled prompts tell an agent to run
 * exists, and every per-framework guide they name is one the plugin ships.
 *
 * An agent cannot tell a stale reference from a real one. The prompts named
 * `bridge integrate` (never registered), `bridge guide <framework> payments`
 * (the feature is `billing`, so it 404ed after every integration) and said the
 * React and Angular SDK guides were unpublished when they had shipped. This
 * reads the commands out of the prompts' code spans and resolves them against
 * the real command tree, and resolves guide features against
 * guide-coverage.json, the one list of which guides exist.
 */
jest.mock('@nebulr-group/bridge-auth-core', () => ({
  __esModule: true,
  BridgeManagement: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../program';
import { loadGuideCoverage } from '../commands/guide.command';
import { DECISION_DOMAINS, JOURNEYS } from '../commands/journeys';

const PROMPTS = join(__dirname, '..', '..', 'prompts');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** Text inside inline code spans and fenced code blocks: where commands live. */
function codeText(markdown: string): string[] {
  const out: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of markdown.matchAll(fenced)) out.push(...m[1].split('\n'));
  const prose = markdown.replace(fenced, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

/**
 * `bridge a b c` sequences, stopping at a flag, a pipe, or the end. A `}` or
 * `,` never starts a token, so the SDK import `import { bridge } from …` is
 * not read as a command.
 */
function commandsIn(text: string): string[][] {
  const found: string[][] = [];
  for (const m of text.matchAll(/(?:^|[\s(])bridge((?: +[^\s`|;)&},]+)+)/g)) {
    const tokens: string[] = [];
    for (const t of m[1].trim().split(/ +/)) {
      if (t.startsWith('-') || t.startsWith('#') || t === '\\') break;
      tokens.push(t);
    }
    if (tokens.length) found.push(tokens);
  }
  return found;
}

const program = new Command();
registerCommands(program);
const coverage = loadGuideCoverage();
const isPlaceholder = (t: string) => /^[<[{].*[>\]}]$/.test(t);

/** Why `tokens` does not resolve, or null when it does. */
function problem(tokens: string[]): string | null {
  let cmd = program;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isPlaceholder(t)) {
      // `bridge guide <framework> <feature>` — the feature must exist for some
      // framework (prompts use the placeholder in frontend- or backend-only lines).
      if (cmd.name() === 'guide' && tokens[i + 1] && !isPlaceholder(tokens[i + 1])) {
        const feature = coverage.aliases[tokens[i + 1]] ?? tokens[i + 1];
        if (!Object.values(coverage.frameworks).some((features) => features.includes(feature))) {
          return `guide '${tokens[i + 1]}' does not exist for any framework`;
        }
      }
      return null;
    }
    const sub = cmd.commands.find((c) => c.name() === t || c.aliases().includes(t));
    if (sub) {
      cmd = sub;
      continue;
    }
    if (cmd.registeredArguments.length === 0) return `'${t}' is not a subcommand of '${cmd.name()}'`;
    // `bridge guide decision <domain>` (TBP-540) — the domain must be one of the seven.
    if (cmd.parent?.name() === 'guide' && cmd.name() === 'decision') {
      return (DECISION_DOMAINS as readonly string[]).includes(t) ? null : `no '${t}' decision guide`;
    }
    // An argument. Under `bridge guide <framework>` it names a guide feature.
    if (cmd.parent?.name() === 'guide' && coverage.frameworks[cmd.name()]) {
      const feature = coverage.aliases[t] ?? t;
      if (!coverage.frameworks[cmd.name()].includes(feature)) {
        return `no '${t}' guide for ${cmd.name()}`;
      }
    }
    return null;
  }
  return null;
}

/**
 * Code spans are checked strictly. Plain text (the success banner is plain
 * text) is checked only where `bridge` is followed by a real top-level
 * command, so prose that happens to say "bridge" is left alone.
 */
function promptCommands(markdown: string): string[][] {
  const topLevel = new Set(program.commands.map((c) => c.name()));
  const inCode = codeText(markdown).flatMap(commandsIn);
  const inText = markdown.split('\n').flatMap(commandsIn).filter((t) => topLevel.has(t[0]));
  const seen = new Set<string>();
  return [...inCode, ...inText].filter((t) => !seen.has(t.join(' ')) && !!seen.add(t.join(' ')));
}

describe('commands named in the bundled prompts (TBP-706)', () => {
  const cases = markdownFiles(PROMPTS).flatMap((file) =>
    promptCommands(readFileSync(file, 'utf-8')).map((tokens) => ({
      file: relative(PROMPTS, file),
      command: `bridge ${tokens.join(' ')}`,
      tokens,
    })),
  );

  it('finds commands to check (guards against the extractor silently matching nothing)', () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  it.each(cases.map((c) => [c.file, c.command, c.tokens] as const))('%s: %s', (_file, _command, tokens) => {
    expect(problem([...tokens])).toBeNull();
  });
});

describe('the resolver itself', () => {
  it.each([
    [['integrate'], /not a subcommand/],
    [['guide', 'svelte', 'payments'], /no 'payments' guide/],
    [['guide', '[framework]', 'payments'], /does not exist for any framework/],
    [['config', 'password-policy'], /not a subcommand/],
    [['guide', 'decision', 'billing'], /no 'billing' decision guide/],
  ])('rejects bridge %j', (tokens, why) => {
    expect(problem(tokens as string[])).toMatch(why);
  });

  it.each([
    [['guide', 'react', 'sdk-auth']],
    [['guide', 'nestjs', 'flags']],
    [['auth', 'password-policy']],
    [['guide', 'decision', 'look-and-feel']],
    [['guide', 'decision', '<name>']],
  ])(
    'accepts bridge %j',
    (tokens) => {
      expect(problem(tokens)).toBeNull();
    },
  );
});

describe('guide-coverage.json', () => {
  it('covers exactly the frameworks `bridge guide` serves', () => {
    const guide = program.commands.find((c) => c.name() === 'guide')!;
    const notFrameworks = [
      'list', 'flags', 'billing', 'mechanisms', 'orientation', 'fit-together', 'decision', 'custom', 'integration-success',
      ...JOURNEYS.map((j) => j.name),
    ];
    const served = guide.commands.map((c) => c.name()).filter((n) => !notFrameworks.includes(n));
    expect(Object.keys(coverage.frameworks).sort()).toEqual(served.sort());
  });
});

describe('commands named by the journeys (TBP-712)', () => {
  const cases = JOURNEYS.flatMap((j) =>
    j.steps.flatMap((step) => codeText(step).flatMap(commandsIn)).map((tokens) => [j.name, `bridge ${tokens.join(' ')}`, tokens] as const),
  );

  it('finds commands to check', () => {
    expect(cases.length).toBeGreaterThan(15);
  });

  it.each(cases)('%s: %s', (_journey, _command, tokens) => {
    expect(problem([...tokens])).toBeNull();
  });
});
