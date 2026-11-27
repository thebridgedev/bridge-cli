import type { Command, Option } from 'commander';
import { buildProgram } from '../../program';

/**
 * CLI 1.0's command tree, from commander itself, and a check of a `bridge …` line against it: every command word must be
 * a command, and every `--option` one of that command's (or the program's). For the 1.0 guides' currency tests (TBP-292).
 */
export function program(): Command {
  return buildProgram({} as never, 'test');
}

/** Every command path, `bridge auth login` and so on, with its long options. */
export function commandPaths(root: Command = program()): { path: string; options: string[] }[] {
  const out: { path: string; options: string[] }[] = [];
  const walk = (command: Command, prefix: string): void => {
    for (const sub of command.commands) {
      const path = `${prefix} ${sub.name()}`;
      out.push({ path, options: sub.options.map((option) => option.long).filter((long): long is string => long !== undefined) });
      walk(sub, path);
    }
  };
  walk(root, 'bridge');
  return out;
}

const PLACEHOLDER = /^[<[{"'…$(]|^\.\.\.$/;
const takesValue = (option: Option): boolean => option.required || option.optional;

/** Splits a command line into words, keeping quoted strings whole. */
function words(line: string): string[] {
  return line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** Why this `bridge …` line is not a CLI 1.0 command, or null when it is one. */
export function checkCommandLine(line: string, root: Command = program()): string | null {
  const tokens = words(line);
  let current = root;
  let argumentsStarted = false;
  const globals = root.options.map((option) => option.long).concat(['--help', '--json']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] as string).replace(/[.,;:)]+$/, '');
    if (token === '' || ['|', '||', '&&', '>', '2>', '#', '\\', '/'].includes(token) || token.startsWith('#')) break;
    if (token.startsWith('--')) {
      const name = token.split('=')[0] as string;
      const option = current.options.find((each) => each.long === name);
      if (option === undefined && !globals.includes(name)) return `\`${name}\` is not an option of \`${current.name()}\``;
      if (option !== undefined && takesValue(option) && !token.includes('=')) index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!argumentsStarted) {
      const alternatives = token.includes('|') && !PLACEHOLDER.test(token) ? token.split('|') : [token];
      const subs = alternatives.map((each) => current.commands.find((sub) => sub.name() === each || sub.aliases().includes(each)));
      if (subs.every((sub) => sub !== undefined)) {
        current = subs[0] as Command;
        continue;
      }
      if (current.commands.length > 0 && PLACEHOLDER.test(token)) return null; // `bridge guide <framework>`: some subcommand
      if (current === root || (current.commands.length > 0 && current.registeredArguments.length === 0)) return `\`${token}\` is not a command under \`${current === root ? 'bridge' : current.name()}\``;
      argumentsStarted = true;
    }
  }
  return null;
}

/** Every `bridge …` command line in a markdown text: in inline code and in fenced blocks, continuation lines joined. */
export function commandLines(markdown: string): string[] {
  const code: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  for (const block of markdown.matchAll(fenced)) code.push(...(block[1] as string).replace(/\s*\\\n\s*/g, ' ').split('\n'));
  const rest = markdown.replace(fenced, '');
  for (const span of rest.matchAll(/`([^`\n]+)`/g)) code.push(span[1] as string);
  const out: string[] = [];
  const start = /(?:^|[\s(|→])(?:npx\s+)?(?:@nebulr-group\/bridge-cli(?:@[\w.-]+)?|bridge)\s+(?=[a-z])/g;
  for (const text of code) {
    for (const found of text.matchAll(start)) out.push(text.slice((found.index ?? 0) + found[0].length));
  }
  return out;
}
