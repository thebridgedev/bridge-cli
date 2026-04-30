/**
 * TBP-113 — PKCE (RFC 7636) helpers.
 *
 * Coverage:
 *  1. base64UrlEncode produces no padding, no '+/' chars.
 *  2. generateCodeVerifier yields a 43-char string in the base64url charset
 *     (43 is the lower bound of the 43-128 range required by the spec).
 *  3. codeChallengeFor matches a known RFC 7636 test vector.
 *  4. generateState yields distinct base64url strings on consecutive calls.
 */
import { base64UrlEncode, codeChallengeFor, generateCodeVerifier, generateState } from '../auth/pkce';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe('pkce', () => {
  describe('base64UrlEncode', () => {
    it('strips trailing = padding', () => {
      // 'foo' base64 = 'Zm9v' (no padding); 'foob' = 'Zm9vYg==' → 'Zm9vYg'
      expect(base64UrlEncode(Buffer.from('foob'))).toBe('Zm9vYg');
    });

    it('replaces + and / with - and _', () => {
      // 0xfb 0xff produces base64 '+/8=' → base64url '-_8'
      expect(base64UrlEncode(Buffer.from([0xfb, 0xff]))).toBe('-_8');
    });
  });

  describe('generateCodeVerifier', () => {
    it('returns a 43-char base64url string (RFC 7636 lower bound)', () => {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(BASE64URL_RE.test(v)).toBe(true);
    });

    it('yields different verifiers on consecutive calls', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe('codeChallengeFor', () => {
    // RFC 7636 Appendix B test vector.
    // verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   → SHA256 base64url no padding "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    it('matches the RFC 7636 test vector', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(codeChallengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('produces a base64url string with no padding', () => {
      const v = generateCodeVerifier();
      const c = codeChallengeFor(v);
      expect(c.length).toBe(43); // SHA-256 = 32 bytes → 43-char base64url
      expect(BASE64URL_RE.test(c)).toBe(true);
    });
  });

  describe('generateState', () => {
    it('returns base64url with no padding', () => {
      const s = generateState();
      expect(BASE64URL_RE.test(s)).toBe(true);
    });

    it('is at least 43 chars (32 bytes of entropy)', () => {
      // 32 bytes → ceil(32 * 8 / 6) = 43 base64url chars (no padding).
      const s = generateState();
      expect(s.length).toBeGreaterThanOrEqual(43);
    });

    it('yields distinct values on consecutive calls', () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toBe(b);
    });
  });
});
