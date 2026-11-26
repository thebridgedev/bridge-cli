/**
 * The loopback HTTP server, and the callback parser and verifier.
 *
 * Coverage:
 *  1. parseCallbackUrl extracts code/state/error/error_description/pathname.
 *  2. verifyCallback rejects state mismatch (CSRF), access_denied → "not approved", any other error → "not finished",
 *     missing code, missing state.
 *  3. startLoopback boots, accepts a single GET /callback, returns parsed result,
 *     and the listener closes after the response is flushed.
 *  4. startLoopback redirectUri uses 127.0.0.1 (NOT localhost) per RFC 8252.
 */
import * as http from 'node:http';
import { LoopbackError, parseCallbackUrl, startLoopback, verifyCallback } from '../auth/loopback';

/** The browser at the loopback: the page's status and text. */
function visit(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('parseCallbackUrl', () => {
  it('extracts code, state, and pathname', () => {
    const r = parseCallbackUrl('/callback?code=abc&state=xyz');
    expect(r.code).toBe('abc');
    expect(r.state).toBe('xyz');
    expect(r.pathname).toBe('/callback');
    expect(r.error).toBeUndefined();
  });

  it('extracts error and error_description', () => {
    const r = parseCallbackUrl('/callback?error=access_denied&error_description=User%20said%20no&state=xyz');
    expect(r.error).toBe('access_denied');
    expect(r.errorDescription).toBe('User said no');
    expect(r.state).toBe('xyz');
    expect(r.code).toBeUndefined();
  });

  it('returns pathname for non-callback paths', () => {
    const r = parseCallbackUrl('/favicon.ico');
    expect(r.pathname).toBe('/favicon.ico');
    expect(r.code).toBeUndefined();
  });
});

describe('verifyCallback', () => {
  it('returns the verified result on success', () => {
    const r = verifyCallback(
      { code: 'a', state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
      's',
    );
    expect(r).toEqual({ code: 'a', state: 's' });
  });

  it('says "not approved" for error=access_denied', () => {
    expect(() =>
      verifyCallback(
        { error: 'access_denied', state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        's',
      ),
    ).toThrow('Sign-in was not approved in the browser.');
  });

  it('throws on state mismatch (CSRF)', () => {
    expect(() =>
      verifyCallback(
        { code: 'a', state: 'wrong', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        'right',
      ),
    ).toThrow(LoopbackError);
    try {
      verifyCallback(
        { code: 'a', state: 'wrong', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        'right',
      );
    } catch (err) {
      expect((err as LoopbackError).kind).toBe('state_mismatch');
    }
  });

  it('throws when code is missing', () => {
    expect(() =>
      verifyCallback(
        { state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        's',
      ),
    ).toThrow(/missing the `code`/);
  });

  it('says "not finished" for any other error, in its own words: never the description the address carries (TBP-971)', () => {
    const failed = (error: string) => {
      try {
        verifyCallback({ error, errorDescription: 'Call 555-0100 for help', state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>, 's');
      } catch (err) {
        return err as LoopbackError;
      }
      throw new Error('no error');
    };
    expect(failed('server_error')).toMatchObject({ kind: 'not_finished', message: 'Sign-in was not finished: Bridge could not complete it.' });
    expect(failed('made_up')).toMatchObject({ kind: 'not_finished' });
    expect(failed('temporarily_unavailable')).toMatchObject({ kind: 'temporarily_unavailable', message: 'Sign-in was not finished: Bridge could not be reached while approving it.' });
    expect(failed('server_error').message).not.toContain('555');
  });

  it("refuses an error that names another issuer: it is not this sign-in's", () => {
    expect(() => verifyCallback(parseCallbackUrl('/callback?error=server_error&state=s&iss=https%3A%2F%2Fevil.test'), 's', 'https://bridge.test/identity-access/apps/a')).toThrow(/another issuer/);
    expect(() => verifyCallback(parseCallbackUrl('/callback?error=server_error&state=s&iss=https%3A%2F%2Fbridge.test%2Fidentity-access%2Fapps%2Fa'), 's', 'https://bridge.test/identity-access/apps/a')).toThrow(/not finished/);
  });
});

describe('the issuer check (RFC 9207)', () => {
  it('accepts a callback that names the issuer, and refuses one that names none', () => {
    const parsed = parseCallbackUrl('/callback?code=c&state=s&iss=https%3A%2F%2Fbridge.test%2Fidentity-access%2Fapps%2Fa');
    expect(parsed.iss).toBe('https://bridge.test/identity-access/apps/a');
    expect(verifyCallback(parsed, 's', 'https://bridge.test/identity-access/apps/a')).toEqual({ code: 'c', state: 's' });
    expect(() => verifyCallback(parseCallbackUrl('/callback?code=c&state=s'), 's', 'https://bridge.test/identity-access/apps/a')).toThrow(/does not name its issuer/);
  });

  it('refuses a callback that names another issuer', () => {
    expect(() => verifyCallback(parseCallbackUrl('/callback?code=c&state=s&iss=https%3A%2F%2Fevil.test'), 's', 'https://bridge.test/identity-access/apps/a')).toThrow(/another issuer/);
  });

  it('checks the state before reporting an error', () => {
    expect(() => verifyCallback(parseCallbackUrl('/callback?error=access_denied&state=forged'), 's')).toThrow(/State mismatch/);
  });
});

describe('startLoopback', () => {
  it('binds 127.0.0.1, accepts a single callback, and shuts down', async () => {
    const lb = await startLoopback({ expectedState: 'STATE-1', timeoutMs: 5000 });
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Hit the loopback like the browser would.
    const port = Number(new URL(lb.redirectUri).port);
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/callback?code=CODE-1&state=STATE-1`,
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });

    const result = await lb.result;
    expect(result).toEqual({ code: 'CODE-1', state: 'STATE-1' });

    // After the callback, the listener should close. Give the server a tick to
    // finish closing (close() runs after the response flushes).
    await new Promise((r) => setTimeout(r, 50));

    // Connecting again should fail because the port is no longer bound.
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/callback`, () => resolve());
        req.on('error', (err) => reject(err));
        req.setTimeout(500, () => reject(new Error('timeout — still listening')));
      }),
    ).rejects.toThrow();
  });

  it('rejects on state mismatch (CSRF)', async () => {
    const lb = await startLoopback({ expectedState: 'EXPECTED', timeoutMs: 5000 });
    const port = Number(new URL(lb.redirectUri).port);

    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/callback?code=CODE&state=WRONG`,
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });

    await expect(lb.result).rejects.toThrow(/State mismatch/);
  });

  it('rejects with "not approved" for access_denied', async () => {
    const lb = await startLoopback({ expectedState: 'S', timeoutMs: 5000 });
    const port = Number(new URL(lb.redirectUri).port);

    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/callback?error=access_denied&state=S`,
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });

    await expect(lb.result).rejects.toThrow('Sign-in was not approved in the browser.');
  });

  it("shows the browser the terminal's own words when the sign-in was not finished, and stops at once (TBP-971)", async () => {
    const lb = await startLoopback({ expectedState: 'S', timeoutMs: 60_000 });
    const failed = lb.result.catch((err: unknown) => err);
    const page = await visit(`${lb.redirectUri}?error=server_error&error_description=%3Cb%3Ex%3C%2Fb%3E&state=S`);
    const err = (await failed) as LoopbackError;
    expect(err.message).toBe('Sign-in was not finished: Bridge could not complete it.');
    expect(page.status).toBe(400);
    expect(page.body).toContain('<h1>Sign-in was not finished</h1>');
    expect(page.body).toContain(`${err.message} Run \`bridge auth login\` again.`);
    expect(page.body).not.toContain('<b>x</b>');
  });

  it('gives up when told, at the sign-in request\'s own expiry, with "expired" (TBP-971)', async () => {
    const lb = await startLoopback({ expectedState: 'S', timeoutMs: 60_000 });
    const started = Date.now();
    lb.expireIn(50);
    await expect(lb.result).rejects.toMatchObject({ kind: 'timeout', message: 'The sign-in request expired before it was approved.' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The port is closed: a late browser finds nobody waiting.
    await new Promise((r) => setTimeout(r, 50));
    await expect(visit(`${lb.redirectUri}?code=c&state=S`)).rejects.toThrow();
  });
});
