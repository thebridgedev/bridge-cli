/**
 * TBP-541 — when the server names the fix for a refused request (e.g.
 * CONFIRMATION_REQUIRED from `bridge test-user create` on production), the CLI
 * prints it as the error's `hint` instead of dropping it or replacing it with
 * a generic one.
 */
import { HttpError } from '@nebulr-group/bridge-auth-core';
import { outputError } from '../output.js';

function captured(err: unknown): { success: false; error: Record<string, unknown> } {
  const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    outputError(err);
    return JSON.parse(String(write.mock.calls[0][0]));
  } finally {
    write.mockRestore();
    process.exitCode = undefined;
  }
}

describe('outputError — the server-authored fix becomes the hint (TBP-541)', () => {
  it('uses body.fix as the hint, with the server code', () => {
    const err = new HttpError('Bad Request', 400, {
      nblocksCode: 'CONFIRMATION_REQUIRED', message: 'needs confirmation', fix: 'Call again with --confirm "Acme".',
    });
    const out = captured(err);
    expect(out.error).toEqual(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED', hint: 'Call again with --confirm "Acme".' }));
  });

  it('without a server fix, a 403 still gets the privilege hint', () => {
    const err = new HttpError("Privilege 'TOKEN_WRITE' required", 403, { message: "Privilege 'TOKEN_WRITE' required" });
    expect(captured(err).error.hint).toContain('bridge auth login --admin');
  });
});
