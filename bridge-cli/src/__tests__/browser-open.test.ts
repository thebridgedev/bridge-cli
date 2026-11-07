/**
 * The browser is opened with no shell: the address is one argument of an
 * argument array, so `&` and the rest of a sign-in address reach the opener
 * whole and nothing in it runs as a command.
 */
import { browserCommand, openBrowser } from '../auth/browser-open';

const ADDRESS = 'https://signin.bridge.test/cli&setup?response_type=code&client_id=bridge-app&code_challenge=abc&state=xyz';

describe('opening the browser', () => {
  it('builds an argument array per platform, rundll32 on Windows, never cmd', () => {
    expect(browserCommand(ADDRESS, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', ADDRESS] });
    expect(browserCommand(ADDRESS, 'darwin')).toEqual({ command: 'open', args: [ADDRESS] });
    expect(browserCommand(ADDRESS, 'linux')).toEqual({ command: 'xdg-open', args: [ADDRESS] });
  });

  it.each(['win32', 'darwin', 'linux'] as const)('on %s, runs the opener through execFile with no shell and the address whole', async (platform) => {
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const result = await openBrowser(ADDRESS, {
      platform,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null);
        return { unref: () => undefined };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({ shell: false });
    expect(calls[0]?.file).not.toMatch(/cmd|powershell|sh$/i);
    expect(calls[0]?.args[calls[0].args.length - 1]).toBe(ADDRESS);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'http://signin.example.com/cli', 'not a url', 'https://user:pw@signin.bridge.test/'])(
    'refuses %s before running anything',
    async (address) => {
      const ran: string[] = [];
      const result = await openBrowser(address, {
        platform: 'win32',
        execFile: (file, _args, _options, callback) => {
          ran.push(file);
          callback(null);
          return undefined;
        },
      });
      expect(result.ok).toBe(false);
      expect(ran).toEqual([]);
    },
  );

  it('reports an opener that fails', async () => {
    const result = await openBrowser('http://localhost:5173/sign-in', { platform: 'linux', execFile: (_f, _a, _o, callback) => (callback(new Error('xdg-open not found')), undefined) });
    expect(result).toEqual({ ok: false, reason: 'xdg-open not found' });
  });
});
