import type { Discovery } from '../core/discovery.js';
import { CliError } from '../core/errors.js';
import { call, type Fetch } from '../core/http.js';
import { secureUrl } from '../core/urls.js';
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
  /** Bridge's sign-in page in hand-off mode. */
  readonly signInPage: string;
  readonly openBrowser: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Told the address when the browser cannot be opened, or always, so it can be opened by hand. */
  readonly show: (message: string) => void;
  readonly timeoutMs?: number;
  /** For tests: called once the loopback listens. */
  readonly onListening?: (loopback: StartedLoopback, url: string) => void;
}

/**
 * The address of the sign-in page for this sign-in: the page signs in with
 * the PKCE challenge and sends the browser back to the loopback address
 * with the code and the state (hand-off mode). Only this process holds the
 * verifier, so only it can trade the code.
 */
export function signInPageUrl(page: string, d: Discovery, request: { codeChallenge: string; redirectUri: string; state: string }): string {
  const url = new URL(page);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', d.appId);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', request.state);
  return url.toString();
}

/** Browser sign-in through Bridge's own sign-in page, with a loopback on 127.0.0.1 and PKCE (RFC 8252, RFC 7636). */
export async function signInWithBrowser(sessions: Sessions, d: Discovery, input: BrowserSignIn): Promise<StoredSession> {
  if (secureUrl(input.signInPage) === null) {
    throw new CliError('misconfigured', `The sign-in page must be an https address (http only on localhost): ${input.signInPage}`);
  }
  const verifier = generateCodeVerifier();
  const state = generateState();
  const loopback = await startLoopback({ expectedState: state, expectedIssuer: d.issuer, timeoutMs: input.timeoutMs });
  const url = signInPageUrl(input.signInPage, d, { codeChallenge: codeChallengeFor(verifier), redirectUri: loopback.redirectUri, state });
  input.onListening?.(loopback, url);
  try {
    const opened = await input.openBrowser(url);
    input.show(
      opened.ok
        ? `Opened your browser to sign in. If it did not open, go to:\n  ${url}`
        : `Open this address in your browser to sign in:\n  ${url}`,
    );
    const { code } = await loopback.result;
    return await sessions.exchangeCode(d, code, verifier);
  } catch (error) {
    if (error instanceof LoopbackError) {
      throw new CliError(error.kind === 'access_denied' ? 'cancelled' : 'invalid', error.message);
    }
    throw error;
  } finally {
    loopback.close();
  }
}
