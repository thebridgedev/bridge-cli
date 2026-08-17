/**
 * TBP-539 — Smoke tests for the `bridge mcp` stdio harness registration.
 *
 * The stdio transport owns stdout once connected, so the core invariant here
 * is: registering (and failing) the command never writes to stdout. We do NOT
 * connect a real StdioServerTransport in tests — that would capture the jest
 * process's stdin/stdout.
 */
import { Command } from 'commander';

// Override only getManagementClient; keep the real ConfigError class so
// output.ts's instanceof mapping still works.
jest.mock('../config', () => {
  const actual = jest.requireActual('../config');
  return {
    ...actual,
    getManagementClient: jest.fn(() => {
      throw new actual.ConfigError('Not logged in. Run `bridge auth login`.');
    }),
  };
});

import { registerMcpCommands } from '../commands/mcp.command';

describe('bridge mcp command', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = 0;
  });

  it('registers an `mcp` subcommand', () => {
    const program = new Command();
    registerMcpCommands(program, '1.2.3');
    const mcp = program.commands.find((c) => c.name() === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp?.description()).toMatch(/Model Context Protocol/);
  });

  it('registration itself writes nothing to stdout', () => {
    const program = new Command();
    registerMcpCommands(program, '1.2.3');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('fails fast on missing credentials via stderr only — stdout stays clean', async () => {
    const program = new Command();
    registerMcpCommands(program, '1.2.3');
    await program.parseAsync(['mcp'], { from: 'user' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    const stderrPayload = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).toContain('CONFIG_ERROR');
    expect(stderrPayload).toContain('bridge auth login');
    expect(process.exitCode).toBe(3);
  });
});
