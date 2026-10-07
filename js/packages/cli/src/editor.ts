import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, spawnCommand } from './child.js';
import { CliError, Context } from './context.js';

/** $VISUAL or $EDITOR as an argument list; quotes group, nothing else is interpreted. */
export function editorCommand(env: NodeJS.ProcessEnv): string[] | undefined {
  const value = (env.VISUAL || env.EDITOR || '').trim();
  if (value === '') return undefined;

  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;

  for (const char of value) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word = (word ?? '') + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Opens the editor on text in a file only this user can read, and returns what was saved. */
export async function editText(ctx: Context, text: string, fileName: string): Promise<string> {
  const command = editorCommand(ctx.env);
  if (!command) throw new CliError('--edit needs an editor: set EDITOR, like EDITOR=nano or EDITOR="code --wait".');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-'));
  const file = path.join(dir, fileName);

  try {
    fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600, flag: 'wx' });
    const child = spawnCommand([...command, file], { cwd: ctx.cwd, env: childEnv(ctx.env), stdio: 'inherit' });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode));
    }).catch((error: Error) => {
      throw new CliError(`Couldn't start ${command[0]}: ${error.message}`);
    });

    if (code !== 0) throw new CliError(`${command[0]} exited with ${code ?? 'a signal'}; nothing was released.`);
    return fs.readFileSync(file, 'utf8').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
