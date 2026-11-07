import { CliError } from './errors.js';

/** The hosts plain http is allowed on: this machine only, for local development. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * An address Bridge is reached at: https, or http only on this machine.
 * No user name or password in it. Returns null for anything else.
 */
export function secureUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLocalHost(url.hostname)) return url;
  return null;
}

/**
 * The issuer, checked and normalized: https (http only on this machine), no
 * query or fragment, no trailing slash. The issuer is the one address the
 * CLI is given; every endpoint comes from its metadata.
 */
export function normalizeIssuer(value: string): string {
  const url = secureUrl(value.trim());
  if (url === null) {
    throw new CliError('misconfigured', `The issuer must be an https address (http only on localhost): ${value}`, {
      hint: 'Pass the Bridge App\'s issuer, for example `--issuer https://api.example.com/identity-access/apps/<app-id>`.',
    });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new CliError('misconfigured', `The issuer has no query or fragment: ${value}`);
  }
  return url.toString().replace(/\/+$/, '');
}

/** Fills `{name}` placeholders with URL-encoded values. */
export function fillPath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new CliError('invalid', `Missing ${name}.`);
    return encodeURIComponent(value);
  });
}
