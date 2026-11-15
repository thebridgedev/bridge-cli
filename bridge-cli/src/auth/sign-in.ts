import type { Discovery } from '../core/discovery.js';
import { CliError } from '../core/errors.js';
import { call, type Fetch } from '../core/http.js';
import { LoopbackError, startLoopback, type StartedLoopback } from './loopback.js';
import { codeChallengeFor, generateCodeVerifier, generateState } from './pkce.js';
import type { Sessions } from './session.js';
import type { StoredSession } from './store.js';

/** A workspace offered at sign-in, and what entering it would still ask for. */
export interface WorkspaceChoice {
  readonly id: string;
  readonly name: string;
  readonly needs?: unknown;
}

export type ChooseWorkspace = (choices: readonly WorkspaceChoice[]) => Promise<string>;

interface ChallengeAnswer {
  readonly code?: string;
  readonly next?: string;
  readonly flow?: string;
  readonly workspaces?: WorkspaceChoice[];
}

export interface PasswordSignIn {
  readonly email: string;
  readonly password: string;
  /** The workspace to enter; asked for with `chooseWorkspace` when the person has several and none is named. */
  readonly workspace?: string;
  readonly chooseWorkspace: ChooseWorkspace;
}

/**
 * Email and password in the terminal, against the Bridge App's challenge
 * endpoint. The Bridge App is a first-party client, so no page is needed.
 * The code is bound with PKCE to this process and traded at once.
 *
 * 1. `{ email, password, code_challenge }` gives a code, or the workspace step.
 * 2. The workspace step: `{ flow, workspace }` gives the code.
 * 3. The token endpoint trades the code and the verifier for tokens.
 */
export async function signInWithPassword(fetchFn: Fetch, sessions: Sessions, d: Discovery, input: PasswordSignIn): Promise<StoredSession> {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFor(verifier);
  let { body } = await call<ChallengeAnswer>(fetchFn, {
    method: 'POST',
    url: d.signIn,
    body: {
      email: input.email,
      password: input.password,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      client_id: d.appId,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    },
  });
  if (typeof body?.code !== 'string' && body?.next === 'workspace' && typeof body.flow === 'string') {
    const choices = Array.isArray(body.workspaces) ? body.workspaces : [];
    const workspace = await input.chooseWorkspace(choices);
    ({ body } = await call<ChallengeAnswer>(fetchFn, { method: 'POST', url: d.signIn, body: { flow: body.flow, workspace, client_id: d.appId } }));
  }
  const code = body?.code;
  if (typeof code !== 'string') {
    throw new CliError('unsupported-step', `Sign-in asks for a step the CLI cannot do in the terminal (${String(body?.next ?? 'none')}).`, {
      hint: 'Sign in with the browser instead: `bridge auth login`.',
    });
  }
  return sessions.exchangeCode(d, code, verifier);
}

export interface BrowserSignIn {
  readonly openBrowser: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Told the address when the browser cannot be opened, or always, so it can be opened by hand. */
  readonly show: (message: string) => void;
  readonly timeoutMs?: number;
  /** For tests: called once the loopback listens. */
  readonly onListening?: (loopback: StartedLoopback, url: string) => void;
}

/** The address to open: Bridge's sign-in page with the request's id, and nothing else of the sign-in in it. */
export function signInPageUrl(page: string, request: string): string {
  const url = new URL(page);
  url.search = new URLSearchParams({ request }).toString();
  return url.toString();
}

/**
 * Starts the sign-in request (in the spirit of RFC 9126): Bridge holds the CLI's PKCE challenge, its `state` and its
 * loopback return, checks the return against the Bridge App's registered ones (a loopback IP on any port, RFC 8252
 * 7.3), and answers with an opaque id. The code made on it goes only to that return, and only the verifier trades it.
 */
async function startRequest(fetchFn: Fetch, d: Discovery, request: { codeChallenge: string; redirectUri: string; state: string }): Promise<string> {
  const { body } = await call<{ request?: unknown }>(fetchFn, {
    method: 'POST',
    url: d.signInRequests as string,
    body: { redirect_uri: request.redirectUri, code_challenge: request.codeChallenge, code_challenge_method: 'S256', state: request.state, client_id: d.appId },
  });
  if (typeof body?.request !== 'string' || body.request === '') throw new CliError('misconfigured', 'Bridge did not start the sign-in request.');
  return body.request;
}

/**
 * Browser sign-in through Bridge's own sign-in page (RFC 8252): a loopback listener on 127.0.0.1, a sign-in request
 * that binds the code to it, PKCE (RFC 7636), the `state`, and the issuer the page names (RFC 9207). The page signs the
 * person in on the request by any method it offers and sends the browser to the loopback with the code; the token
 * endpoint trades it only with this process's verifier and the same `redirect_uri`, once.
 */
export async function signInWithBrowser(fetchFn: Fetch, sessions: Sessions, d: Discovery, input: BrowserSignIn): Promise<StoredSession> {
  if (d.signInPage === null || d.signInRequests === null) {
    throw new CliError('not-offered', 'This Bridge does not offer browser sign-in for the CLI.', {
      hint: 'Sign in in the terminal instead: `bridge auth login --password`.',
    });
  }
  const verifier = generateCodeVerifier();
  const state = generateState();
  const loopback = await startLoopback({ expectedState: state, expectedIssuer: d.issuer, timeoutMs: input.timeoutMs });
  try {
    const request = await startRequest(fetchFn, d, { codeChallenge: codeChallengeFor(verifier), redirectUri: loopback.redirectUri, state });
    const url = signInPageUrl(d.signInPage, request);
    input.onListening?.(loopback, url);
    const opened = await input.openBrowser(url);
    input.show(
      opened.ok
        ? `Opened your browser to sign in. If it did not open, go to:\n  ${url}`
        : `Open this address in your browser to sign in:\n  ${url}`,
    );
    const { code } = await loopback.result;
    return await sessions.exchangeCode(d, code, verifier, loopback.redirectUri);
  } catch (error) {
    if (error instanceof LoopbackError) {
      throw new CliError(error.kind === 'access_denied' ? 'cancelled' : 'invalid', error.message);
    }
    throw error;
  } finally {
    loopback.close();
  }
}
