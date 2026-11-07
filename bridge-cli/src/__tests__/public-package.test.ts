/**
 * The package is public: what it ships (the code, the README) names no
 * internal system and no internal ticket, and speaks to the developer.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = join(__dirname, '..', '..');

function shipped(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : shipped(path);
    return /\.ts$/.test(name) && !/\.(test|stub)\.ts$/.test(name) ? [path] : [];
  });
}

const FORBIDDEN: [string, RegExp][] = [
  ['an internal ticket id', /\bTBP-\d+/],
  ['an internal milestone', /\bTBP-M\d+/],
  ['an internal service name', /\b(?:bridge-api|bridge-server|cloud-views|admin-ui|nblocks|nebulr-haga|verdaccio|gitlab)\b/i],
  ['the owner', /\bthe owner\b/i],
];

describe('the shipped package', () => {
  const files = [...shipped(join(PACKAGE, 'src')), join(PACKAGE, 'README.md')];

  it.each(files.map((file) => [file.slice(PACKAGE.length + 1), file]))('%s names nothing internal', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    for (const [what, pattern] of FORBIDDEN) {
      const hit = pattern.exec(text);
      expect(hit === null ? null : `${what}: ${hit[0]}`).toBeNull();
    }
  });

  it('is version 1.0 alpha and depends on nothing but commander', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^1\.0\.0-alpha\.\d+$/);
    expect(Object.keys(pkg.dependencies)).toEqual(['commander']);
  });
});
