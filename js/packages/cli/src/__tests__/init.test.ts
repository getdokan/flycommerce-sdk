import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCli } from './fake-portal.js';

const exampleConfig = {
  appId: 'order-export',
  versionId: 3,
  version: '1.0.0',
  quote: 'Your orders, in a spreadsheet',
  appUrl: 'http://localhost:4000',
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
};

describe('flycommerce app init', () => {
  let root: string;
  let templates: string;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const cli = (...argv: string[]) => runCli(argv, { env, cwd: dir });
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

  const write = (file: string, contents: unknown) => {
    fs.mkdirSync(path.dirname(path.join(templates, file)), { recursive: true });
    fs.writeFileSync(path.join(templates, file), typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-templates-'));
    const repo = path.join(root, 'examples');
    templates = repo;
    fs.mkdirSync(repo);

    write('README.md', '# Examples');
    write('.github/workflows/ci.yml', 'on: push');
    write('order-export/app-config.json', exampleConfig);
    write('order-export/package.json', { name: 'order-export', version: '1.0.0', private: true, scripts: { dev: 'node src/server.js' } });
    write('order-export/src/server.js', 'export {};\n');
    write('order-export/.gitignore', 'node_modules\n');
    write('order-notifier/app-config.json', { ...exampleConfig, appId: 'order-notifier' });
    write('order-notifier/package.json', { name: 'order-notifier', version: '1.0.0', private: true });

    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env: gitEnv,
        stdio: 'pipe',
      });
    git('init', '--quiet');
    git('add', '--all');
    git('commit', '--quiet', '--message', 'examples');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-init-'));
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      FLYCOMMERCE_TEMPLATES_REPO: pathToFileURL(templates).href,
    };
  });

  it('creates an app from the default template, named after its directory, without the example version', async () => {
    const result = await cli('app', 'init', 'My Shop App');

    assert.equal(result.code, 0, result.stderr);
    const { versionId, version, ...rest } = exampleConfig;
    assert.deepEqual(read('My Shop App/app-config.json'), { ...rest, appId: 'my-shop-app' });
    assert.equal(read('My Shop App/package.json').name, 'my-shop-app');
    assert.deepEqual(read('My Shop App/package.json').scripts, { dev: 'node src/server.js' });
    assert.ok(fs.existsSync(path.join(dir, 'My Shop App', 'src', 'server.js')));
    assert.ok(fs.existsSync(path.join(dir, 'My Shop App', '.gitignore')));
    assert.ok(!fs.existsSync(path.join(dir, 'My Shop App', '.git')));
    assert.ok(!fs.existsSync(path.join(dir, 'My Shop App', '.github')));
    assert.match(result.stdout, /from the order-export example/);
    assert.match(result.stdout, /cd "My Shop App"/);
    assert.match(result.stdout, /flycommerce app link --config dev/);
  });

  it('starts from another example with --template, in the current directory', async () => {
    const result = await cli('app', 'init', '--template', 'order-notifier');

    assert.equal(result.code, 0, result.stderr);
    assert.equal(read('app-config.json').appId, path.basename(dir).toLowerCase());
    assert.equal(read('package.json').name, path.basename(dir).toLowerCase());
    assert.doesNotMatch(result.stdout, /\bcd\b/);
  });

  for (const template of ['..', '../order-export', 'order-export/../order-notifier', '.github', '/etc', 'Order-Export', '-x']) {
    it(`refuses ${JSON.stringify(template)} as a template, before downloading anything`, async () => {
      env.FLYCOMMERCE_TEMPLATES_REPO = pathToFileURL(path.join(root, 'missing')).href;
      const result = await cli('app', 'init', 'app', `--template=${template}`);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /isn't an example's name/);
      assert.ok(!fs.existsSync(path.join(dir, 'app')));
    });
  }

  it('names the examples when there is no such one, and creates nothing', async () => {
    const result = await cli('app', 'init', 'app', '--template', 'order-review');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /There's no example order-review\. The examples: order-export, order-notifier\./);
    assert.ok(!fs.existsSync(path.join(dir, 'app')));
  });

  it('refuses a directory that has anything in it, and leaves it alone', async () => {
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app', '.gitignore'), 'mine\n');

    const result = await cli('app', 'init', 'app');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't empty/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'app')), ['.gitignore']);
    assert.equal(fs.readFileSync(path.join(dir, 'app', '.gitignore'), 'utf8'), 'mine\n');
  });

  it('accepts a directory holding only a new git repository', async () => {
    fs.mkdirSync(path.join(dir, 'app', '.git'), { recursive: true });

    const result = await cli('app', 'init', 'app');

    assert.equal(result.code, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'app', 'app-config.json')));
  });

  it('refuses a file where the directory should be', async () => {
    fs.writeFileSync(path.join(dir, 'app'), 'x');

    const result = await cli('app', 'init', 'app');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't a directory/);
  });

  it("says why when the examples can't be downloaded, and creates nothing", async () => {
    env.FLYCOMMERCE_TEMPLATES_REPO = pathToFileURL(path.join(root, 'missing')).href;

    const result = await cli('app', 'init', 'app');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Couldn't download the examples from file:\/\/.*missing: /);
    assert.ok(!fs.existsSync(path.join(dir, 'app')));
  });

  it('says it needs git when git is not installed', async () => {
    env.PATH = path.join(root, 'no-git-here');

    const result = await cli('app', 'init', 'app');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /needs git to download the example: git is not installed/);
    assert.ok(!fs.existsSync(path.join(dir, 'app')));
  });

  it('refuses a templates repository that is not an https, ssh or file URL', async () => {
    for (const repo of ['--upload-pack=touch pwned', 'ext::sh -c touch% pwned', 'http://example.com/x.git']) {
      env.FLYCOMMERCE_TEMPLATES_REPO = repo;
      const result = await cli('app', 'init', 'app');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /FLYCOMMERCE_TEMPLATES_REPO must be an https:\/\/, ssh:\/\/ or file:\/\/ URL/);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
  });

  it(
    'runs git without a shell, with the URL after --, without FLYCOMMERCE_* and without prompting',
    { skip: process.platform === 'win32' },
    async () => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-fake-git-'));
      const log = path.join(bin, 'log');
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nenv >> "${log}"\necho "fatal: offline" >&2\nexit 128\n`,
        {
          mode: 0o755,
        }
      );
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      env.FLYCOMMERCE_TOKEN = 'flyc_secret';

      const result = await cli('app', 'init', 'app');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Couldn't download the examples from .*: offline/);
      const lines = fs.readFileSync(log, 'utf8').split('\n');
      const separator = lines.indexOf('--');
      assert.deepEqual(lines.slice(0, 4), ['clone', '--depth', '1', '--quiet']);
      assert.equal(lines[separator + 1], env.FLYCOMMERCE_TEMPLATES_REPO);
      assert.ok(lines.includes('GIT_TERMINAL_PROMPT=0'));
      assert.ok(!lines.some((line) => line.startsWith('FLYCOMMERCE_')));
      fs.rmSync(bin, { recursive: true, force: true });
    }
  );

  it('takes one directory', async () => {
    const result = await cli('app', 'init', 'one', 'two');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /takes one directory/);
  });
});
