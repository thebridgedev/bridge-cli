import { readFile, writeFile } from 'node:fs/promises';

/** A variable name a `.env` file can hold. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The text of a `.env` file with `name` set to `value`: the first line that sets it (`NAME=…` or `export NAME=…`) is
 * replaced, any later ones are removed, and every other line is kept as it was. Added at the end when it is not there.
 */
export function withEnvValue(text: string, name: string, value: string): string {
  if (!NAME.test(name)) throw new Error(`${name} is not a variable name.`);
  const sets = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const line = `${name}=${value}`;
  let found = false;
  const out = lines.flatMap((each) => {
    if (!sets.test(each)) return [each];
    if (found) return [];
    found = true;
    return [line];
  });
  if (!found) out.push(line);
  return `${out.join('\n')}\n`;
}

/** Sets one variable in a `.env` file, making the file when there is none. Returns whether the file changed. */
export async function setEnvValue(file: string, name: string, value: string): Promise<boolean> {
  let before = '';
  try {
    before = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const after = withEnvValue(before, name, value);
  if (after === before) return false;
  await writeFile(file, after, 'utf8');
  return true;
}
