import { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The environment for a process the CLI starts: never the portal token, nor any other FLYCOMMERCE_* setting. */
export function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('FLYCOMMERCE_')));
  return { ...clean, ...extra };
}

// cmd.exe reads these itself unless each is escaped with ^.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument as cmd.exe passes it on, quoted for the program's own parser; a batch file parses it once more. */
export function quoteWindowsArg(arg: string, batch: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return batch ? quoted.replace(CMD_META, '^$1') : quoted;
}

/** The whole command line for `cmd.exe /d /s /c "<line>"`. */
export function windowsCommandLine(command: string[], batch: boolean): string {
  const [program, ...args] = command;
  return [program.replace(CMD_META, '^$1'), ...args.map((arg) => quoteWindowsArg(arg, batch))].join(' ');
}

/** Whether a Windows command resolves to a .cmd or .bat shim, like npm, through PATH and PATHEXT. */
export function isWindowsBatch(program: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const extension = path.extname(program).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') return true;
  if (extension !== '') return false;

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs =
    program.includes('/') || program.includes('\\') ? [''] : [cwd, ...(env[pathKey] ?? '').split(path.delimiter).filter(Boolean)];

  for (const dir of dirs) {
    for (const ext of extensions) {
      if (fs.existsSync(path.resolve(cwd, dir, program + ext))) {
        return ['.cmd', '.bat'].includes(ext.toLowerCase());
      }
    }
  }
  return false;
}

/** Starts a command without a shell; on Windows through cmd.exe with every argument quoted, since npm and friends are .cmd shims. */
export function spawnCommand(command: string[], options: SpawnOptions & { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  if (process.platform !== 'win32') {
    return spawn(command[0], command.slice(1), { ...options, shell: false });
  }

  const line = windowsCommandLine(command, isWindowsBatch(command[0], options.env, options.cwd));
  return spawn(options.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}
