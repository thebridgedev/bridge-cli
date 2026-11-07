import { createInterface } from 'node:readline';
import { CliError, exitCodeOf, isCliError } from './core/errors.js';

/**
 * Where a command's output goes. Results are JSON on stdout,
 * `{ "success": true, "data": … }`, so scripts and coding agents can read
 * them; errors are JSON on stderr, `{ "success": false, "error": … }`;
 * messages for the person at the terminal go to stderr as plain text.
 */
export interface Io {
  result(data: unknown): void;
  /** Plain text on stdout, for reports meant to be read as they are. */
  text(content: string): void;
  info(message: string): void;
  error(error: unknown): void;
  readonly interactive: boolean;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  readStdin(): Promise<string>;
  setExitCode(code: number): void;
}

export function errorBody(error: unknown): Record<string, unknown> {
  if (isCliError(error)) {
    return {
      code: error.kind,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'error', message: error instanceof Error ? error.message : String(error) };
}

function question(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // Echo nothing of what is typed after the prompt.
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(prompt)) write.call(rl, prompt);
        else if (s.includes('\n') || s.includes('\r')) write.call(rl, '\n');
      };
    }
    rl.on('SIGINT', () => {
      rl.close();
      reject(new CliError('cancelled', 'Cancelled.'));
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const processIo: Io = {
  result: (data) => process.stdout.write(JSON.stringify({ success: true, data }, null, 2) + '\n'),
  text: (content) => process.stdout.write(content.endsWith('\n') ? content : `${content}\n`),
  info: (message) => process.stderr.write(`${message}\n`),
  error: (error) => {
    process.stderr.write(JSON.stringify({ success: false, error: errorBody(error) }, null, 2) + '\n');
    process.exitCode = exitCodeOf(error);
  },
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  ask: (prompt) => question(prompt, false),
  askHidden: (prompt) => question(prompt, true),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};
