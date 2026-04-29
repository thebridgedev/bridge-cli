/**
 * TBP-113 — bridge-api CLI auth client.
 *
 * Coverage:
 *  1. exchangeCode POSTs to /v1/auth/cli/token with `{code, code_verifier}` and
 *     parses the JSON body.
 *  2. RFC error translation: invalid_request, invalid_grant, expired_grant,
 *     access_denied — each becomes a CliAuthApiError with the matching code.
 *  3. revokeToken sends `x-api-key` (NOT `Authorization: Bearer`) and treats
 *     401 as success (token already revoked).
 *  4. revokeToken on network failure rejects with code='network_error'.
 */
import { CliAuthApiError, createCliApiClient } from '../auth/api-client';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createCliApiClient.exchangeCode', () => {
  it('POSTs JSON with code + code_verifier and returns the parsed body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        api_token: 'fake-jwt-abc',
        expires_at: '2099-01-01T00:00:00.000Z',
        app: { id: 'a1', name: 'Acme' },
        user: { id: 'u1', email: 'alice@acme.com' },
      }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });

    const out = await api.exchangeCode({ code: 'C', codeVerifier: 'V' });

    expect(out.api_token).toBe('fake-jwt-abc');
    expect(out.app.id).toBe('a1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/auth/cli/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers['content-type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ code: 'C', code_verifier: 'V' });
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        api_token: 'x',
        expires_at: '2099-01-01T00:00:00.000Z',
        app: { id: 'a', name: 'A' },
        user: { id: 'u', email: 'a@b.c' },
      }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com/', fetchImpl });
    await api.exchangeCode({ code: 'c', codeVerifier: 'v' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.com/v1/auth/cli/token');
  });

  it('translates invalid_grant to a friendly CliAuthApiError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(
        { error: 'invalid_grant', error_description: 'code already used' },
        { status: 400 },
      ),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });

    await expect(api.exchangeCode({ code: 'C', codeVerifier: 'V' })).rejects.toMatchObject({
      name: 'CliAuthApiError',
      code: 'invalid_grant',
    });
  });

  it('translates expired_grant', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ error: 'expired_grant' }, { status: 400 }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    await expect(api.exchangeCode({ code: 'C', codeVerifier: 'V' })).rejects.toMatchObject({
      code: 'expired_grant',
      message: expect.stringMatching(/expired/i),
    });
  });

  it('translates invalid_request and surfaces error_description if provided', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(
        { error: 'invalid_request', error_description: 'missing code' },
        { status: 400 },
      ),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });

    try {
      await api.exchangeCode({ code: 'C', codeVerifier: 'V' });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliAuthApiError);
      expect((err as CliAuthApiError).code).toBe('invalid_request');
      expect((err as CliAuthApiError).message).toContain('missing code');
    }
  });

  it('falls back to http_error when the body is non-JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('not json', { status: 500 }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    await expect(api.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({
      code: 'http_error',
      status: 500,
    });
  });
});

describe('createCliApiClient.revokeToken', () => {
  it('POSTs with x-api-key header and resolves on 200', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    const r = await api.revokeToken('jwt-1');
    expect(r.revoked).toBe(true);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/auth/cli/revoke');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('jwt-1');
    // Critical: the CLI must NOT use Authorization: Bearer (TBP-111 contract).
    expect(opts.headers['Authorization']).toBeUndefined();
    expect(opts.headers['authorization']).toBeUndefined();
  });

  it('treats 401 as success (token already revoked or expired)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    const r = await api.revokeToken('jwt-1');
    expect(r.revoked).toBe(true);
  });

  it('translates non-401 errors via the RFC mapping', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ error: 'invalid_request' }, { status: 400 }),
    );
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    await expect(api.revokeToken('jwt-1')).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('wraps network failures as CliAuthApiError(code=network_error)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const api = createCliApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    await expect(api.revokeToken('jwt-1')).rejects.toMatchObject({
      code: 'network_error',
      status: 0,
    });
  });
});
