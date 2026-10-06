import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { credentialsPath } from '../credentials.js';
import { FakePortal, runCli } from './fake-portal.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-cli-'));
// What a browser does with the authorize link: follow the portal's redirect to the loopback.
const browser = (url: string) => void fetch(url).catch(() => {});

describe('flycommerce login', () => {
  let portal: FakePortal;
  let staging: FakePortal;

  before(async () => {
    portal = await FakePortal.start('flyc_production_token');
    staging = await FakePortal.start('flyc_staging_token');
  });

  after(async () => {
    await portal.close();
    await staging.close();
  });

  it('signs in with PKCE through a loopback, and keeps the token in a file only the user can read', async () => {
    const dir = home();
    const env = { XDG_CONFIG_HOME: dir };
    const result = await runCli(['login', '--portal', portal.url], { env, cwd: dir, openUrl: browser });

    assert.equal(result.code, 0, result.stderr);
    const query = portal.authorizeQuery!;
    assert.match(query.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.ok((query.get('state') ?? '').length >= 32, 'a random state');

    const exchange = portal.requests.find((request) => request.path === '/api/cli/v1/token')!;
    assert.equal(exchange.body.code, 'one-time-code');
    assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), query.get('code_challenge'));
    assert.equal(exchange.body.redirect_uri, query.get('redirect_uri'));
    assert.equal(exchange.authorization, undefined);

    const file = credentialsPath(env);
    assert.equal(file, path.join(dir, 'flycommerce', 'credentials.json'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).portals[portal.url].token, 'flyc_production_token');
    assert.match(result.stdout, /Signed in to .* as Dev Person <dev@example\.com>/);
    assert.match(result.stdout, /cli\/authorize\?redirect_uri=/, 'the link is printed for a headless terminal');
    assert.ok(!(result.stdout + result.stderr).includes('flyc_production_token'), 'the token is never printed');
  });

  it("refuses an answer whose state isn't the one it sent, and never exchanges the code", async () => {
    const dir = home();
    portal.forgedState = 'forged-state';
    portal.requests.length = 0;

    try {
      const result = await runCli(['login', '--portal', portal.url], { env: { XDG_CONFIG_HOME: dir }, cwd: dir, openUrl: browser });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /state mismatch/);
      assert.ok(!portal.requests.some((request) => request.path === '/api/cli/v1/token'));
      assert.ok(!fs.existsSync(credentialsPath({ XDG_CONFIG_HOME: dir })));
    } finally {
      portal.forgedState = undefined;
    }
  });

  it('gives up when nobody answers in time', async () => {
    const dir = home();
    const result = await runCli(['login', '--portal', portal.url], { env: { XDG_CONFIG_HOME: dir }, cwd: dir, loginTimeoutMs: 50 });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out/);
  });

  it('keeps one sign-in per portal, side by side, and signs out of one only', async () => {
    const dir = home();
    const env = { XDG_CONFIG_HOME: dir };

    assert.equal((await runCli(['login', '--portal', portal.url], { env, cwd: dir, openUrl: browser })).code, 0);
    assert.equal((await runCli(['login'], { env: { ...env, FLYCOMMERCE_PORTAL_URL: staging.url }, cwd: dir, openUrl: browser })).code, 0);

    const saved = JSON.parse(fs.readFileSync(credentialsPath(env), 'utf8')).portals;
    assert.equal(saved[portal.url].token, 'flyc_production_token');
    assert.equal(saved[staging.url].token, 'flyc_staging_token');
    assert.equal((await runCli(['whoami', '--portal', staging.url], { env, cwd: dir })).code, 0);

    assert.equal((await runCli(['logout', '--portal', portal.url], { env, cwd: dir })).code, 0);
    assert.match((await runCli(['whoami', '--portal', portal.url], { env, cwd: dir })).stderr, /not signed in/);
    assert.equal((await runCli(['whoami', '--portal', staging.url], { env, cwd: dir })).code, 0);
  });

  it('uses FLYCOMMERCE_TOKEN over the saved sign-in, without saving or printing it', async () => {
    const dir = home();
    const env = { XDG_CONFIG_HOME: dir };
    await runCli(['login', '--portal', staging.url], { env, cwd: dir, openUrl: browser });
    staging.requests.length = 0;

    const withEnv = await runCli(['whoami', '--portal', staging.url], { env: { ...env, FLYCOMMERCE_TOKEN: 'flyc_ci_token' }, cwd: dir });
    assert.equal(withEnv.code, 1);
    assert.equal(staging.requests.at(-1)?.authorization, 'Bearer flyc_ci_token');
    assert.match(withEnv.stderr, /FLYCOMMERCE_TOKEN was refused/);

    const fresh = home();
    const ci = await runCli(['whoami', '--portal', portal.url], {
      env: { XDG_CONFIG_HOME: fresh, FLYCOMMERCE_TOKEN: 'flyc_production_token' },
      cwd: fresh,
    });
    assert.equal(ci.code, 0, ci.stderr);
    assert.match(ci.stdout, /with FLYCOMMERCE_TOKEN/);
    assert.ok(!ci.stdout.includes('flyc_production_token'));
    assert.ok(!fs.existsSync(credentialsPath({ XDG_CONFIG_HOME: fresh })));
  });

  it('refuses a portal that is not https, except on this computer', async () => {
    const dir = home();
    const result = await runCli(['whoami', '--portal', 'http://developers.example.com'], {
      env: { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: 'x' },
      cwd: dir,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /must use https/);
  });
});

describe('the flycommerce binary', () => {
  it('prints its help and exits 0', async () => {
    const bin = path.join(import.meta.dirname, '..', 'cli.js');
    const { stdout } = await promisify(execFile)(process.execPath, [bin, '--help']);

    assert.match(stdout, /^Usage: flycommerce <command>/);
    assert.match(stdout, /app release/);
  });
});
