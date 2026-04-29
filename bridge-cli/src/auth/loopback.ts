/**
 * Single-shot loopback HTTP server for the PKCE auth flow.
 *
 * Per RFC 8252:
 *  - Bind to `127.0.0.1` (NOT `localhost` — DNS spoofing risk).
 *  - Use an OS-assigned ephemeral port (`port: 0`).
 *  - Handle exactly one request, then close the listener.
 *
 * The server understands two response shapes from the IdP:
 *   `?code=<code>&state=<state>`            → success
 *   `?error=access_denied&state=<state>`    → user cancelled (or other error)
 *
 * It also CSRF-checks the returned `state` against the value the caller
 * generated.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface RunLoopbackOptions {
  /** The CSRF state the caller generated; must match what the IdP echoes. */
  expectedState: string;
  /**
   * If set, the loopback responds 302 → this URL on success instead of
   * rendering the inline HTML. Used to bounce the browser to a hosted,
   * branded "you can close this tab" page on cloud-views.
   * Falls back to inline HTML if not provided.
   */
  successRedirectUrl?: string;
  /** Body of the success page rendered to the browser when no redirect URL is set. */
  successHtml?: string;
  /** Total time (ms) we'll wait for the redirect before giving up. */
  timeoutMs?: number;
}

export interface StartedLoopback {
  /** The redirect URI to pass to the IdP, e.g. `http://127.0.0.1:54321/callback`. */
  redirectUri: string;
  /** Resolves with the verified `{ code, state }` once the redirect arrives. */
  result: Promise<LoopbackResult>;
  /** Force-close the server (e.g. on Ctrl-C or a token-exchange failure). */
  close: () => void;
}

/**
 * Bridge wordmark — inlined SVG so the page renders without any network fetch.
 * `fill="currentColor"` makes it themable via CSS `color`.
 * Source: bridge-cloud-views/static/assets/logos/bridge_logo.svg (color stripped).
 */
const BRIDGE_LOGO = `<svg viewBox="0 0 818 148" xmlns="http://www.w3.org/2000/svg" aria-label="The Bridge" role="img"><path d="M668.241 0.0799866C684.368 0.0801786 696.657 3.98507 705.105 11.7929C713.026 19.1143 717.515 29.8687 718.572 44.0547C718.691 45.659 717.471 47.0329 715.868 47.1651L686.915 49.5511C685.213 49.6914 683.752 48.3801 683.562 46.6823C682.997 41.6277 681.537 37.8701 679.183 35.4091C676.367 32.3372 672.272 30.8008 666.896 30.8007C661.392 30.8007 656.783 32.5927 653.071 36.1767C649.487 39.6326 646.8 44.5604 645.008 50.9599C643.216 57.2319 642.319 64.5929 642.319 73.0409C642.319 81.4885 643.279 88.657 645.199 94.5448C647.119 100.433 649.936 104.977 653.648 108.177C657.36 111.248 661.776 112.785 666.896 112.785C672.656 112.785 677.135 110.734 680.334 106.639C683.534 102.543 685.136 96.5923 685.136 88.7851C685.136 87.8304 684.362 87.0565 683.408 87.0565H661.447C659.79 87.0565 658.447 85.7134 658.447 84.0565V62.9833C658.447 61.3265 659.79 59.9833 661.447 59.9833H716.695C718.352 59.9833 719.695 61.3265 719.695 62.9833V143.96C719.695 145.617 718.352 146.96 716.695 146.96H692.4C690.803 146.96 689.487 145.709 689.404 144.115L687.838 113.854C687.83 113.685 687.69 113.553 687.521 113.553C687.364 113.553 687.231 113.668 687.207 113.823C685.525 124.573 681.955 132.931 676.497 138.897C671.121 144.913 663.566 147.921 653.838 147.921C644.111 147.921 635.536 144.782 628.113 138.511C620.817 132.239 615.12 123.537 611.024 112.401C607.056 101.137 605.071 88.2723 605.071 73.8085C605.071 59.0885 607.439 46.2237 612.175 35.2157C617.039 24.0798 624.145 15.4408 633.489 9.29678C642.961 3.153 654.545 0.0799866 668.241 0.0799866Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M245.083 1.04092C254.682 1.041 262.683 2.63982 269.083 5.83975C275.482 9.03973 280.154 13.3281 283.098 18.704C286.17 24.0797 287.706 29.9675 287.707 36.3671C287.707 44.5587 285.21 51.855 280.218 58.2548C275.401 64.5932 268.511 68.7991 259.55 70.8689C259.398 70.9041 259.289 71.0397 259.289 71.1961C259.289 71.3696 259.423 71.5143 259.596 71.5302C269.811 72.4674 277.582 75.9152 282.905 81.871C288.409 87.759 291.161 95.9522 291.161 106.448C291.161 119.12 286.489 129.04 277.145 136.208C267.929 143.376 255.257 146.96 239.129 146.96H187.986C186.329 146.96 184.986 145.617 184.986 143.96V4.04093C184.986 2.38407 186.329 1.04092 187.986 1.04092H245.083ZM221.657 112.472C221.657 114.128 223 115.472 224.657 115.472H235.866C241.754 115.472 246.104 114.191 248.92 111.631C251.864 108.943 253.338 105.231 253.338 100.495C253.338 95.7595 251.864 92.1125 248.92 89.5526C246.104 86.8649 241.753 85.5214 235.866 85.5214H224.657C223 85.5214 221.657 86.8645 221.657 88.5214V112.472ZM221.657 60.4403C221.657 62.0972 223 63.4403 224.657 63.4403H235.098C240.729 63.4403 244.953 62.0964 247.769 59.4091C250.585 56.5931 251.994 52.7506 251.994 47.8866C251.993 42.8953 250.585 39.0549 247.769 36.3671C244.953 33.6797 240.729 32.3359 235.098 32.3358H224.657C223 32.3358 221.657 33.679 221.657 35.3358V60.4403Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M365.258 1.04092C379.849 1.04104 390.793 4.23949 398.088 10.6386C405.384 17.0386 409.034 25.5527 409.034 36.1767C409.034 45.0084 406.537 52.7533 401.545 59.4091C396.593 65.8845 388.87 70.5342 378.376 73.357C378.227 73.397 378.123 73.5319 378.123 73.6857C378.123 73.8626 378.259 74.0098 378.436 74.0249C384.683 74.5595 389.507 76.0248 392.906 78.4169C396.489 80.8489 399.176 84.4331 400.968 89.1689C402.76 93.7768 404.362 100.562 405.77 109.521C407.434 119.12 408.905 126.863 410.185 132.751C411.588 138.62 413.246 143.283 415.158 146.735C415.171 146.758 415.177 146.783 415.177 146.809C415.177 146.892 415.11 146.96 415.026 146.96H377.595C376.304 146.96 375.152 146.135 374.778 144.899C373.912 142.04 373.171 139.015 372.553 135.824C371.913 131.728 371.019 126.031 369.867 118.735C368.715 110.288 367.689 104.335 366.793 100.879C365.897 97.4234 364.361 94.8639 362.185 93.2001C360.009 91.5363 356.746 90.7041 352.394 90.704H345.026C343.369 90.704 342.026 92.0472 342.026 93.704V143.96C342.026 145.617 340.683 146.96 339.026 146.96H308.355C306.698 146.96 305.355 145.617 305.355 143.96V4.04093C305.355 2.38407 306.698 1.04092 308.355 1.04092H365.258ZM342.026 62.1689C342.026 63.8257 343.369 65.1689 345.026 65.1689H354.313C360.073 65.1689 364.554 63.7602 367.754 60.9442C370.954 58.0003 372.553 53.9674 372.553 48.8476C372.553 43.7278 370.954 39.6948 367.754 36.7509C364.554 33.8069 360.073 32.3358 354.313 32.3358H345.026C343.369 32.3358 342.026 33.679 342.026 35.3358V62.1689Z" fill="currentColor"/><path d="M463.892 143.96C463.892 145.617 462.549 146.96 460.892 146.96H430.221C428.564 146.96 427.221 145.617 427.221 143.96V4.04093C427.221 2.38407 428.564 1.04092 430.221 1.04092H460.892C462.549 1.04092 463.892 2.38407 463.892 4.04092V143.96Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M526.892 1.04092C540.716 1.04106 552.556 4.11101 562.412 10.2548C572.395 16.3987 579.947 24.9756 585.067 35.9833C590.315 46.9913 592.939 59.6005 592.939 73.8085C592.939 88.6562 590.315 101.584 585.067 112.592C579.947 123.599 572.395 132.111 562.412 138.127C552.556 144.015 540.716 146.96 526.892 146.96H484.962C483.306 146.96 481.962 145.617 481.962 143.96V4.04093C481.962 2.38407 483.306 1.04092 484.962 1.04092H526.892ZM518.443 111.127C518.443 112.784 519.786 114.127 521.443 114.127H526.315C535.531 114.127 542.699 110.929 547.819 104.529C553.067 98.1293 555.691 87.8882 555.691 73.8085C555.691 60.1128 553.067 50.065 547.819 43.6649C542.571 37.1369 535.403 33.871 526.315 33.871H521.443C519.786 33.871 518.443 35.2141 518.443 36.871V111.127Z" fill="currentColor"/><path d="M817.409 29.3358C817.409 30.9927 816.066 32.3358 814.409 32.3358H775.866C774.209 32.3358 772.866 33.679 772.866 35.3358V55.6386C772.866 57.2954 774.209 58.6386 775.866 58.6386H811.722C813.379 58.6386 814.722 59.9817 814.722 61.6386V84.247C814.722 85.9038 813.379 87.247 811.722 87.247H775.866C774.209 87.247 772.866 88.5901 772.866 90.247V112.472C772.866 114.128 774.209 115.472 775.866 115.472H814.602C816.259 115.472 817.602 116.815 817.602 118.472V143.96C817.602 145.617 816.259 146.96 814.602 146.96H739.385C737.728 146.96 736.385 145.617 736.385 143.96V4.04093C736.385 2.38407 737.728 1.04092 739.385 1.04092H814.409C816.066 1.04092 817.409 2.38407 817.409 4.04092V29.3358Z" fill="currentColor"/><path d="M24.978 46.28C6.738 46.28 0.21 38.024 0.402 30.536C0.402 22.856 7.122 14.792 17.682 14.792C23.826 14.792 28.434 17.48 29.586 21.512C29.586 21.896 29.778 22.28 29.778 22.472C29.778 23.432 29.01 23.816 27.282 23.432C25.938 23.048 25.362 22.664 23.634 22.664C18.834 22.664 16.338 25.736 16.338 28.616C16.146 33.416 22.098 34.568 27.858 34.568C30.162 34.568 32.466 34.376 34.194 34.184C51.858 32.264 106.194 19.4 135.378 19.4C142.482 19.4 147.666 20.168 150.546 21.704C151.314 22.088 151.698 22.472 151.698 22.856C151.698 23.24 150.93 23.624 149.394 23.816C96.786 29.96 58.194 43.016 33.042 45.704C30.354 46.088 27.666 46.28 24.978 46.28ZM134.226 141.896C128.274 141.896 123.666 139.208 122.514 135.176C122.514 134.792 122.322 134.408 122.322 134.024C122.322 133.064 123.09 132.872 124.818 133.256C126.162 133.448 126.738 134.024 128.466 134.024C133.266 134.024 135.762 130.952 135.762 127.88C135.762 123.272 130.002 122.12 124.242 122.12C121.938 122.12 119.634 122.312 117.906 122.504C100.242 124.424 45.906 137.096 16.722 137.096C9.618 137.096 4.434 136.52 1.362 134.792C0.786 134.408 0.402 134.024 0.402 133.832C0.402 133.448 1.17 133.064 2.706 132.872C55.314 126.728 93.906 113.672 119.058 110.792C121.746 110.6 124.434 110.408 127.122 110.408C145.362 110.408 151.89 118.472 151.698 126.152C151.698 133.64 144.978 141.896 134.226 141.896Z" fill="currentColor"/></svg>`;

/**
 * Shared <style> block — matches bridge-cloud-views / bridge-admin-ui brand tokens
 * (see bridge-cloud-views/src/global.css). Light mode, Inter, Bridge purple accent,
 * slate text scale, white card with subtle border.
 */
const SHARED_STYLES = `
  :root {
    --color-bridge-purple-1: #8049ff;
    --color-bridge-green-1: #c4ffb8;
    --color-bridge-green-2: #1fb800;
    --color-bridge-red: #d6210b;
    --color-background: #ffffff;
    --color-background-muted: #f8fafc;
    --color-foreground: #0f172a;
    --color-foreground-muted: #64748b;
    --color-border: #e2e8f0;
    --radius-lg: 0.75rem;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--color-background-muted);
    color: var(--color-foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .card {
    text-align: center;
    padding: 3rem 3.5rem;
    border-radius: var(--radius-lg);
    background: var(--color-background);
    border: 1px solid var(--color-border);
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06);
    max-width: 28rem;
  }
  .logo {
    color: var(--color-foreground);
    width: 7rem;
    height: auto;
    margin: 0 auto 2rem;
    display: block;
  }
  .icon {
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1.25rem;
    display: block;
  }
  h1 {
    font-size: 1.375rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
    letter-spacing: -0.01em;
    color: var(--color-foreground);
  }
  p {
    margin: 0;
    color: var(--color-foreground-muted);
    font-size: 0.9375rem;
    line-height: 1.55;
  }
`;

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`;

const SUCCESS_ICON = `<svg class="icon" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#c4ffb8" stroke="#1fb800" stroke-width="2"/><path d="M14 24l7 7 13-14" fill="none" stroke="#1fb800" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FAILURE_ICON = `<svg class="icon" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#fee2e2" stroke="#d6210b" stroke-width="2"/><path d="M16 16l16 16M32 16L16 32" fill="none" stroke="#d6210b" stroke-width="3" stroke-linecap="round"/></svg>`;

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bridge CLI — Login successful</title>
  ${FONT_LINK}
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <main class="card">
    <span class="logo">${BRIDGE_LOGO}</span>
    ${SUCCESS_ICON}
    <h1>Login successful</h1>
    <p>You can close this tab and return to your terminal.</p>
  </main>
</body>
</html>`;

const FAILURE_HTML = (msg: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bridge CLI — Login failed</title>
  ${FONT_LINK}
  <style>${SHARED_STYLES} h1 { color: var(--color-bridge-red); }</style>
</head>
<body>
  <main class="card">
    <span class="logo">${BRIDGE_LOGO}</span>
    ${FAILURE_ICON}
    <h1>Login failed</h1>
    <p>${escapeHtml(msg)}</p>
  </main>
</body>
</html>`;

/**
 * Parses the loopback callback URL to extract `code`, `state`, `error`, and
 * `error_description` query parameters.
 *
 * Exposed for unit testing.
 */
export function parseCallbackUrl(rawUrl: string): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  pathname: string;
} {
  // The `?` at the front is enough; we don't care about base validity.
  const url = new URL(rawUrl, 'http://127.0.0.1');
  return {
    code: url.searchParams.get('code') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
    errorDescription: url.searchParams.get('error_description') ?? undefined,
    pathname: url.pathname,
  };
}

/**
 * Validates a parsed callback against the expected CSRF state. Returns the
 * verified `{code, state}` or throws a friendly error.
 */
export function verifyCallback(
  parsed: ReturnType<typeof parseCallbackUrl>,
  expectedState: string,
): LoopbackResult {
  if (parsed.error) {
    if (parsed.error === 'access_denied') {
      throw new LoopbackError('Login cancelled.', 'access_denied');
    }
    const desc = parsed.errorDescription ? `: ${parsed.errorDescription}` : '';
    throw new LoopbackError(`Authorization failed (${parsed.error})${desc}`, parsed.error);
  }
  if (!parsed.code) {
    throw new LoopbackError('Authorization callback was missing the `code` parameter.', 'invalid_callback');
  }
  if (!parsed.state) {
    throw new LoopbackError('Authorization callback was missing the `state` parameter.', 'invalid_callback');
  }
  if (!constantTimeEqual(parsed.state, expectedState)) {
    throw new LoopbackError('State mismatch on authorization callback (possible CSRF).', 'state_mismatch');
  }
  return { code: parsed.code, state: parsed.state };
}

/**
 * Boots the single-shot loopback listener on a random ephemeral port.
 *
 * Returns immediately with `{ redirectUri, result }`. The caller passes
 * `redirectUri` to the IdP, then awaits `result` for the verified `{code, state}`.
 *
 * The server:
 *  - Closes itself after the first GET to `/callback` completes its response.
 *  - Closes itself if the token-exchange caller invokes `close()` (e.g. on a
 *    later failure that wants to abort the wait).
 *  - Times out after `timeoutMs` (default 5 minutes).
 */
export async function startLoopback(opts: RunLoopbackOptions): Promise<StartedLoopback> {
  const {
    expectedState,
    successRedirectUrl,
    successHtml = DEFAULT_SUCCESS_HTML,
    timeoutMs = 5 * 60_000,
  } = opts;

  let resolveResult!: (r: LoopbackResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<LoopbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = http.createServer((req, res) => {
    // Only one path matters; ignore favicon/etc.
    const parsed = parseCallbackUrl(req.url ?? '/');
    if (parsed.pathname !== '/callback') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }

    try {
      const verified = verifyCallback(parsed, expectedState);
      if (successRedirectUrl) {
        // Bounce the browser to the hosted success page on cloud-views.
        // The user lands on auth.thebridge.dev/cli/login-complete instead of
        // staying on 127.0.0.1 — branded UX.
        res.statusCode = 302;
        res.setHeader('Location', successRedirectUrl);
        res.end(() => {
          server.close();
        });
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(successHtml, () => {
          // Close listener AFTER the response flushes so the user actually sees the page.
          server.close();
        });
      }
      resolveResult(verified);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(FAILURE_HTML(msg), () => {
        server.close();
      });
      rejectResult(err instanceof Error ? err : new Error(msg));
    }
  });

  // Bind on 127.0.0.1 explicitly (RFC 8252). port: 0 → OS picks a free port.
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rej);
      res();
    });
  });

  const addr = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

  // Hard timeout — never leave a port bound forever.
  const timeoutHandle = setTimeout(() => {
    rejectResult(
      new LoopbackError(
        `Timed out waiting for the browser callback after ${Math.round(timeoutMs / 1000)}s.`,
        'timeout',
      ),
    );
    server.close();
  }, timeoutMs);
  // Don't keep the process alive for the timeout once the server closes.
  timeoutHandle.unref?.();

  // Make sure the timeout is cleared whichever way the promise settles.
  result.finally(() => clearTimeout(timeoutHandle)).catch(() => {
    /* swallow — we only attached this for cleanup */
  });

  return {
    redirectUri,
    result,
    close: () => {
      try {
        server.close();
      } catch {
        // server already closed; ignore.
      }
    },
  };
}

export class LoopbackError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.name = 'LoopbackError';
    this.kind = kind;
  }
}

/** Constant-time string comparison for CSRF state checking. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
