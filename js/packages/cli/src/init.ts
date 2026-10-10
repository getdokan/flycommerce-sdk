import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonObject } from './config-file.js';
import { CliError, Context } from './context.js';
import { GitError, shallowClone } from './git.js';

export const EXAMPLES_REPO = 'https://github.com/getdokan/flycommerce-app-examples.git';
export const DEFAULT_TEMPLATE = 'order-export';

// A top-level directory of the examples repository, never a path, so it can't reach outside the clone.
const TEMPLATE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_URL = /^(https|ssh|file):\/\//;

export interface InitOptions {
  directory?: string;
  template?: string;
}

/** Copies an example app into a new or empty directory, named after it; creates nothing in the portal. */
export function initApp(ctx: Context, options: InitOptions): void {
  const template = options.template ?? DEFAULT_TEMPLATE;
  if (!TEMPLATE.test(template)) {
    throw new CliError(`"${template}" isn't an example's name, like ${DEFAULT_TEMPLATE}.`);
  }

  const repoUrl = ctx.env.FLYCOMMERCE_TEMPLATES_REPO || EXAMPLES_REPO;
  if (!REPO_URL.test(repoUrl)) {
    throw new CliError('FLYCOMMERCE_TEMPLATES_REPO must be an https://, ssh:// or file:// URL.');
  }

  const target = path.resolve(ctx.cwd, options.directory ?? '.');
  const shown = path.relative(ctx.cwd, target);
  refuseUnlessEmpty(target, shown);

  const name = packageName(path.basename(target));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-examples-'));

  try {
    try {
      shallowClone(repoUrl, clone, ctx.env);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new CliError(
        error.notInstalled
          ? `flycommerce app init needs git to download the example: ${error.message}.`
          : `Couldn't download the examples from ${repoUrl}: ${error.message}`
      );
    }

    const source = path.join(clone, template);
    const configFile = path.join(source, 'app-config.json');
    const packageFile = path.join(source, 'package.json');
    const { versionId, version, ...config } = readExampleFile(clone, template, configFile);
    const pkg = readExampleFile(clone, template, packageFile);

    fs.cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (file) => file !== configFile && file !== packageFile,
    });
    // wx: never overwrite a file that appeared since the directory was checked.
    fs.writeFileSync(path.join(target, 'app-config.json'), JSON.stringify({ ...config, appId: name }, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ ...pkg, name }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    fs.rmSync(clone, { recursive: true, force: true, maxRetries: 3 });
  }

  const cd = shown === '' ? [] : [`  cd ${/\s/.test(shown) ? `"${shown}"` : shown}`];
  ctx.stdout(
    [
      `Created ${name} from the ${template} example${shown === '' ? '' : ` in ${shown}`}.`,
      '',
      'Try it on the emulator, no account needed:',
      ...cd,
      '  npm install',
      '  npm run dev',
      '',
      'To run it on your own store, create a development app in the developer portal, then:',
      '  flycommerce app link --config dev',
      '  flycommerce app dev --config dev',
      '',
      'README.md explains the example.',
    ].join('\n')
  );
}

function refuseUnlessEmpty(target: string, shown: string): void {
  let entries: string[];

  try {
    entries = fs.readdirSync(target);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return;
    if (code === 'ENOTDIR') throw new CliError(`${shown} isn't a directory.`);
    throw error;
  }

  if (entries.some((entry) => entry !== '.git')) {
    throw new CliError(`${shown === '' ? 'This directory' : shown} isn't empty. Give a new directory, like: flycommerce app init my-app`);
  }
}

// A symlinked or incomplete directory isn't an example: it could point outside the clone.
function readExampleFile(clone: string, template: string, file: string): Record<string, unknown> {
  if (fs.lstatSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory()) {
    try {
      return readJsonObject(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new CliError(`There's no example ${template}. The examples: ${examples(clone).join(', ')}.`);
}

function isExample(dir: string): boolean {
  return ['app-config.json', 'package.json'].every((file) => fs.existsSync(path.join(dir, file)));
}

function examples(clone: string): string[] {
  return fs
    .readdirSync(clone, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TEMPLATE.test(entry.name) && isExample(path.join(clone, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/** The directory's name as an npm package name, which also stands in for the App ID until flycommerce app link. */
function packageName(directory: string): string {
  return (
    directory
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 100)
      .replace(/^-+|-+$/g, '') || 'flycommerce-app'
  );
}
