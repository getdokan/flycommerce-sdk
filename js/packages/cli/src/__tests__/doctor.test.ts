import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakePortal, runCli } from './fake-portal.js';

const config = {
  appId: 'order-export',
  appUrl: 'https://export.example.com',
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
};

const goodEnv = [
  'APP_ID=order-export',
  'APP_SECRET=never-printed-secret',
  'HUB_API_URL=https://developers.example.test/api',
  'JWKS_URL=https://hub.example.test/.well-known/jwks.json',
  'ALLOWED_ISSUERS=https://hub.example.test',
  '',
].join('\n');

// A PATH holding only git: cloudflared, wherever it's installed, can't be found.
function gitOnlyPath(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-git-only-'));
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(git, path.join(bin, 'git'));
  return bin;
}

const gitDir = gitOnlyPath();

describe('flycommerce doctor', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let signedIn: boolean;
  const cli = () =>
    runCli(['doctor', '--portal', portal.url], { env: signedIn ? { ...env, FLYCOMMERCE_TOKEN: portal.token } : env, cwd: dir });
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-doctor-'));
    // Only git's folder on PATH, so no cloudflared: a warning, never a failure.
    env = { XDG_CONFIG_HOME: dir, PATH: gitDir };
    signedIn = true;
    portal.apps.clear();
    portal.addApp({ appId: 'order-export', name: 'Order Export' });
    portal.addApp({ appId: 'order-export-prod', name: 'Order Export', status: 'published' });
    write('app-config.json', JSON.stringify(config));
    write('.env', goodEnv);
    git('init', '--quiet');
    write('.gitignore', '.env\n');
  });

  it('passes a project that is ready, and never prints a value from .env', async () => {
    const result = await cli();

    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /✓ app-config\.json is valid/);
    assert.match(result.stdout, /✓ Signed in to .* as Dev Person/);
    assert.match(result.stdout, /✓ app-config\.json: Order Export \(unpublished\)/);
    assert.match(result.stdout, /✓ \.env has APP_ID, APP_SECRET, HUB_API_URL/);
    assert.match(result.stdout, /✓ \.env points at https:\/\/developers\.example\.test's platform/);
    assert.match(result.stdout, /✓ git ignores \.env/);
    assert.match(result.stdout, /! cloudflared is not installed\n {4}app dev needs it/);
    assert.match(result.stdout, /Nothing to fix\./);
    assert.doesNotMatch(result.stdout, /never-printed-secret/);
  });

  it('fails a .env that points at another platform, and one git would commit', async () => {
    write('.env', goodEnv.replace('https://developers.example.test/api', 'https://developers.flycommerce.com/api'));
    write('.gitignore', '');

    const result = await cli();

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✗ \.env's HUB_API_URL point at another platform than .*\n {4}flycommerce env pull/);
    assert.match(result.stdout, /✗ git doesn't ignore \.env, so its secrets could be committed/);
    assert.match(result.stdout, /2 to fix\./);
  });

  it('accepts ALLOWED_ISSUERS written with spaces or in another order', async () => {
    portal.environment = { ...portal.environment, allowedIssuers: ['https://hub.example.test', 'https://old.example.test'] };
    write(
      '.env',
      goodEnv.replace('ALLOWED_ISSUERS=https://hub.example.test', 'ALLOWED_ISSUERS="https://old.example.test https://hub.example.test"')
    );

    const result = await cli();

    portal.environment = { ...portal.environment, allowedIssuers: ['https://hub.example.test'] };
    assert.equal(result.code, 0, result.stdout);
  });

  it('fails a missing .env key, an invalid config, and an app that is not yours', async () => {
    write('.env', 'APP_ID=order-export\n');
    write('app-config.dev.json', JSON.stringify({ ...config, appId: 'someone-elses' }));
    write('app-config.staging.json', '{ not json');

    const result = await cli();

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✗ \.env is missing APP_SECRET, HUB_API_URL\n {4}flycommerce env pull/);
    assert.match(result.stdout, /✗ app-config\.dev\.json: someone-elses isn't one of your apps .*\n {4}flycommerce app link --config dev/);
    assert.match(result.stdout, /✗ app-config\.staging\.json is not valid JSON/);
  });

  it('warns when a development config points at a published app', async () => {
    write('app-config.dev.json', JSON.stringify({ ...config, appId: 'order-export-prod' }));

    const result = await cli();

    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /! app-config\.dev\.json: Order Export is published, so app dev won't push to it/);
  });

  it('fails without a sign-in, an app-config.json or a .env, and still checks the rest', async () => {
    signedIn = false;
    fs.rmSync(path.join(dir, 'app-config.json'));
    fs.rmSync(path.join(dir, '.env'));

    const result = await cli();

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✗ No app-config\.json here/);
    assert.match(result.stdout, /✗ You're not signed in to .*\n {4}flycommerce login/);
    assert.match(result.stdout, /✗ No \.env here/);
    assert.match(result.stdout, /✓ Node /);
  });
});
