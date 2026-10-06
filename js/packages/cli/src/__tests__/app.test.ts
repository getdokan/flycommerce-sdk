import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakePortal, runCli } from './fake-portal.js';

const production = {
  appId: 'order-export',
  versionId: 3,
  version: '1.0.0',
  appUrl: 'https://export.example.com',
  install: { redirectUrl: '/auth/callback' },
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
  storefront: { scripts: [{ handle: 'welcome', src: '/storefront/welcome.js' }] },
};

describe('flycommerce app', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const cli = (...argv: string[]) => runCli([...argv, '--portal', portal.url], { env, cwd: dir });
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-app-'));
    env = { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: portal.token };
    portal.apps.clear();
    portal.requests.length = 0;
    portal.releaseAnswer = undefined;
    portal.addApp({ appId: 'order-export', name: 'Order Export', published: true, status: 'published' });
    portal.addApp({ appId: 'order-export-dev', name: 'Order Export (dev)' });
  });

  it('lists the apps', async () => {
    const result = await cli('app', 'list');

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /order-export\s+Order Export\s+published/);
    assert.match(result.stdout, /order-export-dev\s+Order Export \(dev\)\s+unpublished/);
  });

  it('links a new app-config.dev.json as a copy of app-config.json with the dev app, and updates appId in place', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production, null, 4));

    const linked = await cli('app', 'link', '--config', 'dev', '--app', 'order-export-dev');
    assert.equal(linked.code, 0, linked.stderr);
    const { versionId, version, ...unversioned } = production;
    assert.deepEqual(read('app-config.dev.json'), { ...unversioned, appId: 'order-export-dev' });

    const text = fs.readFileSync(path.join(dir, 'app-config.json'), 'utf8');
    assert.equal((await cli('app', 'link', '--app', 'order-export-dev')).code, 0);
    assert.equal(
      fs.readFileSync(path.join(dir, 'app-config.json'), 'utf8'),
      text.replace('"appId": "order-export"', '"appId": "order-export-dev"')
    );
  });

  it('starts a config from a template when there is none, and asks which app when none is given', async () => {
    const result = await runCli(['app', 'link', '--portal', portal.url], { env, cwd: dir, prompt: async () => '2' });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(read('app-config.json').appId, 'order-export-dev');
    assert.deepEqual(read('app-config.json').install, { redirectUrl: '/auth/callback' });
  });

  it("refuses an app that isn't the developer's, listing theirs", async () => {
    const result = await cli('app', 'link', '--app', 'someone-elses');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no app someone-elses/);
    assert.match(result.stderr, /1\. Order Export \(order-export\), published/);
    assert.ok(!fs.existsSync(path.join(dir, 'app-config.json')));
  });

  it('creates the version, then releases it with versionId and version filled in', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.releaseAnswer = {
      status: 200,
      body: { versionId: 1, version: '1.2.0', released: true, awaitingReview: ['export', 'welcome'] },
    };

    const result = await cli('app', 'release', '--version', '1.2.0', '--message', 'Adds a welcome banner');

    assert.equal(result.code, 0, result.stderr);
    const calls = portal.apiCalls().map((call) => `${call.method} ${call.path}`);
    assert.deepEqual(calls, [
      'GET /api/cli/v1/apps/order-export',
      'POST /api/cli/v1/apps/order-export/versions',
      'POST /api/cli/v1/apps/order-export/versions/1/release',
    ]);
    assert.deepEqual(portal.apiCalls()[1].body, { version: '1.2.0', title: '1.2.0', changelog: 'Adds a welcome banner' });
    assert.deepEqual(portal.apiCalls()[2].body.config, { ...production, versionId: 1, version: '1.2.0' });
    assert.match(result.stdout, /Released 1\.2\.0 \(#1\) of Order Export/);
    assert.match(result.stdout, /Waiting for FlyCommerce's review[^]*  - export\n  - welcome/);
  });

  it("prints the hub's problems and exits 1 when the release is refused", async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.releaseAnswer = {
      status: 422,
      body: {
        error: 'invalid_config',
        message: 'app-config.json is not valid.',
        problems: ['storefront.scripts.0.src: A script loads from the app’s own host.'],
      },
    };

    const result = await cli('app', 'release', '--version', '1.2.0', '--message', 'x', '--title', 'Welcome');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error: app-config\.json is not valid\./);
    assert.match(result.stderr, /  - storefront\.scripts\.0\.src: A script loads from the app’s own host\./);
    assert.match(result.stderr, /Version 1\.2\.0 \(#1\) exists but isn't released/);
    assert.equal(portal.apiCalls()[1].body.title, 'Welcome');
  });

  it('stops after creating the version with --no-release, and the next release picks it up', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));

    const created = await cli('app', 'release', '--version', '1.2.0', '--message', 'x', '--no-release');
    assert.equal(created.code, 0, created.stderr);
    assert.ok(!portal.apiCalls().some((call) => call.path.endsWith('/release')));

    const released = await cli('app', 'release', '--version', '1.2.0', '--message', 'x');
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stdout, /already exists and isn't released; using it/);
    assert.equal(portal.apiCalls().at(-1)?.path, '/api/cli/v1/apps/order-export/versions/1/release');
    assert.equal(portal.apps.get('order-export')!.versions.length, 1);
    assert.match(released.stdout, /Everything in it is live/);

    const versions = await cli('app', 'versions');
    assert.match(versions.stdout, /1\.2\.0\s+#1\s+live/);
    assert.match((await cli('app', 'release', '--version', '1.2.0', '--message', 'x')).stderr, /already released/);
  });

  it('refuses to create a version while another is waiting to be released', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.apps.get('order-export')!.versions.push({ versionId: 1, version: '1.2.0', title: '1.2.0', releasedAt: null });

    const result = await cli('app', 'release', '--version', '1.3.0', '--message', 'x');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Version 1\.2\.0 \(#1\) of Order Export is waiting to be released, so 1\.3\.0 can't be created yet/);
    assert.match(result.stderr, /- Release it: flycommerce app release --version 1\.2\.0/);
    assert.ok(!portal.apiCalls().some((call) => call.path.endsWith('/release')));
  });

  it('checks the config locally before calling the portal', async () => {
    fs.writeFileSync(
      path.join(dir, 'app-config.json'),
      JSON.stringify({ ...production, storefront: { scripts: [{ handle: 'w', src: '//evil.example/w.js' }] } })
    );

    const result = await cli('app', 'release', '--version', '1.2.0', '--message', 'x');

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /app-config\.json is not valid:\n  - storefront\.scripts\[0\]\.src must be a path starting with a single \//
    );
    assert.deepEqual(portal.apiCalls(), []);
  });

  it("doesn't follow a redirect with the token", async () => {
    const elsewhere = await FakePortal.start(portal.token);
    portal.redirectTo = `${elsewhere.url}/api/cli/v1/apps`;

    try {
      const result = await cli('app', 'list');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /redirected the request instead of answering it/);
      assert.deepEqual(elsewhere.requests, []);
    } finally {
      portal.redirectTo = undefined;
      await elsewhere.close();
    }
  });

  it("shows the portal's names as plain text: no escape sequences, links or bidi overrides", async () => {
    const ESC = '\u001b';
    const evil = `Evil${ESC}]8;;https://phish.example${ESC}\\link${ESC}]8;;${ESC}\\${ESC}[2J${ESC}[31mRED\u202eexe.txt\u2066\u0085\u0007`;
    portal.addApp({ appId: 'evil-app', name: evil });
    portal.apps.get('order-export')!.versions.push({ versionId: 1, version: '1.0.0', title: evil, releasedAt: null });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.me = { name: evil, email: `dev@example.com${ESC}[8m` };

    try {
      const outputs = [
        await cli('app', 'list'),
        await cli('whoami'),
        await cli('app', 'versions'),
        await cli('app', 'link', '--app', 'nope'),
      ];
      const text = outputs.map((result) => result.stdout + result.stderr).join('\n');

      assert.match(text, /evil-app\s+EvillinkREDexe\.txt\s+unpublished/);
      assert.match(text, /as EvillinkREDexe\.txt <dev@example\.com>/);
      assert.match(text, /1\.0\.0\s+#1\s+not released\s+EvillinkREDexe\.txt/);
      assert.match(text, /\(evil-app\)/);
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text), JSON.stringify(text));
    } finally {
      portal.me = { name: 'Dev Person', email: 'dev@example.com' };
    }
  });

  it("doesn't call a version live while the app itself waits for review", async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.apps.get('order-export')!.status = 'pending';

    const pending = await cli('app', 'release', '--version', '1.2.0', '--message', 'x');
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /Order Export is waiting for FlyCommerce's review, so this version goes live once it's approved/);
    assert.doesNotMatch(pending.stdout, /Everything in it is live/);

    portal.apps.get('order-export')!.status = 'published';
    portal.releaseAnswer = { status: 200, body: { versionId: 2, version: '1.3.0', released: true, awaitingReview: [], live: false } };
    const notLive = await cli('app', 'release', '--version', '1.3.0', '--message', 'x');
    assert.match(notLive.stdout, /goes live once it's approved/);
    assert.doesNotMatch(notLive.stdout, /Everything in it is live/);
  });

  it('says a changed install redirect waits for review, and that merchants still use the approved one', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    portal.releaseAnswer = {
      status: 200,
      body: { versionId: 1, version: '1.2.0', released: true, awaitingReview: ['welcome', 'install.redirectUrl'] },
    };

    const result = await cli('app', 'release', '--version', '1.2.0', '--message', 'x');

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Waiting for FlyCommerce's review[^]*  - welcome\n/);
    assert.doesNotMatch(result.stdout, /  - install\.redirectUrl/);
    assert.match(
      result.stdout,
      /Your install redirect change waits for review; merchants still return to the approved URL until then — keep that route working\./
    );
    assert.doesNotMatch(result.stdout, /Everything in it is live/);
  });

  it('tells a developer whose token was refused to sign in again', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
    const result = await runCli(['app', 'versions', '--portal', portal.url], {
      env: { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: 'revoked' },
      cwd: dir,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /FLYCOMMERCE_TOKEN was refused/);
  });
});
