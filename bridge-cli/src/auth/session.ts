import type { Discovery } from '../core/discovery.js';
import { CliError, SIGN_IN_AGAIN } from '../core/errors.js';
import { call, type Fetch } from '../core/http.js';
import { withLock } from './lock.js';
import type { SessionStore, StoredSession } from './store.js';

/** Renew this long before the access token expires, so a call never carries one that runs out on the way. */
const RENEW_BEFORE_MS = 60_000;

export interface TokenAnswer {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly workspace?: string;
}

function tokenAnswer(body: unknown): TokenAnswer {
  const answer = (body ?? {}) as Record<string, unknown>;
  if (typeof answer['access_token'] !== 'string' || typeof answer['expires_in'] !== 'number') {
    throw new CliError('misconfigured', 'The token endpoint answered without an access token.');
  }
  return answer as unknown as TokenAnswer;
}

export interface SessionDeps {
  readonly fetch: Fetch;
  readonly store: SessionStore;
  /** Where the renewal lock lives. */
  readonly lockDir: string;
  readonly now?: () => number;
}

/**
 * The developer's session with the Bridge App: kept in the store, renewed
 * with rotation (each renewal gives a new refresh token, saved before it is
 * used), ended by revoking the refresh token.
 */
export class Sessions {
  private readonly now: () => number;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now;
  }

  describeStore(): string {
    return this.deps.store.describe();
  }

  /** Trades a sign-in code for tokens (PKCE: only the holder of the verifier can) and keeps them. */
  async exchangeCode(d: Discovery, code: string, verifier: string): Promise<StoredSession> {
    const { body } = await call(this.deps.fetch, {
      method: 'POST',
      url: d.token,
      body: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: d.appId },
    });
    const session = this.fromAnswer(d, tokenAnswer(body), null, this.now());
    await this.deps.store.write(session);
    return session;
  }

  async read(issuer: string): Promise<StoredSession | null> {
    return this.deps.store.read(issuer);
  }

  /** Removes the session from this machine only. */
  async forget(issuer: string): Promise<void> {
    await this.deps.store.remove(issuer);
  }

  /** The signed-in session for the issuer, or `not-signed-in`. */
  async current(d: Discovery): Promise<StoredSession> {
    const session = await this.deps.store.read(d.issuer);
    if (session === null) throw new CliError('not-signed-in', `Not signed in to ${d.issuer}.`, { hint: SIGN_IN_AGAIN });
    return session;
  }

  /** An access token that is good for at least a minute, renewed first if needed. */
  async accessToken(d: Discovery, options: { force?: boolean } = {}): Promise<string> {
    const session = await this.current(d);
    if (!options.force && session.accessTokenExpiresAt - this.now() > RENEW_BEFORE_MS) return session.accessToken;
    return (await this.renew(d, { force: options.force, stale: session.accessToken })).accessToken;
  }

  /**
   * Renews the tokens, optionally for another workspace. Under a lock, and
   * with the store read again inside it: a command that ran at the same
   * time may have renewed already, and its refresh token is the only one
   * still good.
   */
  async renew(d: Discovery, options: { workspace?: string; force?: boolean; stale?: string } = {}): Promise<StoredSession> {
    return withLock(this.deps.lockDir, 'renew', async () => {
      const session = await this.current(d);
      const renewedMeanwhile = options.stale !== undefined && session.accessToken !== options.stale;
      if (options.workspace === undefined && renewedMeanwhile && session.accessTokenExpiresAt - this.now() > RENEW_BEFORE_MS) return session;
      if (session.refreshToken === null) {
        await this.deps.store.remove(d.issuer);
        throw new CliError('session-ended', 'The session cannot be renewed.', { hint: SIGN_IN_AGAIN });
      }
      let body: unknown;
      try {
        ({ body } = await call(this.deps.fetch, {
          method: 'POST',
          url: d.token,
          body: {
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: d.appId,
            ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
          },
        }));
      } catch (error) {
        // Refused for good: the session ended (signed out elsewhere, removed from the workspace, the token reused).
        if (error instanceof CliError && error.kind === 'session-ended') {
          await this.deps.store.remove(d.issuer);
          throw new CliError('session-ended', `The session ended: ${error.message}`, { status: error.status, hint: SIGN_IN_AGAIN });
        }
        throw error;
      }
      const renewed = this.fromAnswer(d, tokenAnswer(body), session, session.signedInAt);
      await this.deps.store.write(renewed);
      return renewed;
    });
  }

  /**
   * Signs out: revokes the refresh token, which ends the session at Bridge,
   * then forgets it here. Forgotten here even when Bridge cannot be
   * reached, and then says so.
   */
  async signOut(d: Discovery): Promise<{ revoked: boolean; reason?: string }> {
    const session = await this.deps.store.read(d.issuer);
    if (session === null) return { revoked: false, reason: 'not signed in' };
    let revoked = false;
    let reason: string | undefined;
    try {
      if (session.refreshToken !== null) {
        await call(this.deps.fetch, { method: 'POST', url: d.revoke, body: { token: session.refreshToken, token_type_hint: 'refresh_token', client_id: d.appId } });
        revoked = true;
      } else if (d.signOut !== null) {
        await call(this.deps.fetch, { method: 'POST', url: d.signOut, headers: { authorization: `Bearer ${session.accessToken}` } });
        revoked = true;
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await this.deps.store.remove(d.issuer);
    return reason === undefined ? { revoked } : { revoked, reason };
  }

  private fromAnswer(d: Discovery, answer: TokenAnswer, previous: StoredSession | null, signedInAt: number): StoredSession {
    return {
      issuer: d.issuer,
      appId: d.appId,
      accessToken: answer.access_token,
      accessTokenExpiresAt: this.now() + answer.expires_in * 1000,
      // Rotation: the new refresh token replaces the old one, which is now spent.
      refreshToken: answer.refresh_token ?? previous?.refreshToken ?? null,
      workspace: answer.workspace ?? null,
      signedInAt,
    };
  }
}
