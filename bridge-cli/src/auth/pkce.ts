/**
 * PKCE (RFC 7636) and CSRF state helpers for bridge-cli's loopback auth flow.
 *
 * - `code_verifier`: 43–128 chars from the unreserved set, cryptographically
 *   random. We generate 32 bytes of entropy and base64url-encode without
 *   padding → 43 characters, the lower bound of the spec.
 * - `code_challenge`: SHA-256 hash of the verifier, base64url-encoded without
 *   padding (the only `code_challenge_method` we support is S256).
 * - `state`: 32 random bytes, base64url-encoded — the CSRF token the loopback
 *   server checks against the value the IdP echoes back.
 *
 * The verifier and the JWT it eventually unlocks are NEVER logged.
 */
import * as crypto from 'node:crypto';

/** Encodes a Buffer as base64url (RFC 4648 §5) with no `=` padding. */
export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Generates a cryptographically random PKCE `code_verifier`.
 *
 * Output: 43-character base64url string (the RFC 7636 lower bound). 32 bytes
 * of entropy provides ~256 bits of security.
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

/**
 * Computes the PKCE `code_challenge` for an S256 verifier:
 *   challenge = base64url(sha256(verifier))    (no padding)
 */
export function codeChallengeFor(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

/**
 * Generates a CSRF `state` value (32 random bytes, base64url-encoded).
 */
export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}
