/**
 * TBP-113 — loopback HTTP server + callback parser/verifier.
 *
 * Coverage:
 *  1. parseCallbackUrl extracts code/state/error/error_description/pathname.
 *  2. verifyCallback rejects state mismatch (CSRF), access_denied → "Login cancelled.",
 *     missing code, missing state.
 *  3. startLoopback boots, accepts a single GET /callback, returns parsed result,
 *     and the listener closes after the response is flushed.
 *  4. startLoopback redirectUri uses 127.0.0.1 (NOT localhost) per RFC 8252.
 */
import * as http from 'node:http';
import { LoopbackError, parseCallbackUrl, startLoopback, verifyCallback } from '../auth/loopback';

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

  it('throws "Login cancelled." for error=access_denied', () => {
    expect(() =>
      verifyCallback(
        { error: 'access_denied', state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        's',
      ),
    ).toThrow(/Login cancelled\./);
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

  it('throws on a generic OAuth error', () => {
    expect(() =>
      verifyCallback(
        { error: 'server_error', errorDescription: 'boom', state: 's', pathname: '/callback' } as ReturnType<typeof parseCallbackUrl>,
        's',
      ),
    ).toThrow(/server_error.*boom/);
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

  it('rejects with "Login cancelled." for access_denied', async () => {
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

    await expect(lb.result).rejects.toThrow(/Login cancelled\./);
  });
});
