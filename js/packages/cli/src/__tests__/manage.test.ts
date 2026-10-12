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
};

describe('flycommerce app create, status, open, secret and token', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let opened: string[];
  const cli = (argv: string[], extra: { prompt?: (question: string) => Promise<string>; env?: NodeJS.ProcessEnv } = {}) =>
    runCli([...argv, '--portal', portal.url], {
      env: extra.env ?? env,
      cwd: dir,
      prompt: extra.prompt,
      openUrl: (url) => opened.push(url),
    });
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  const answer = (text: string) => async () => text;

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-manage-'));
    env = { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: portal.token };
    opened = [];
    portal.apps.clear();
    portal.deployTokens.clear();
    portal.requests.length = 0;
    portal.addApp({ appId: 'order-export', name: 'Order Export', status: 'published', published: true });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production, null, 2));
  });

  describe('app create', () => {
    it('creates an unpublished app, links app-config.dev.json with --dev, and shows the secret once', async () => {
      const result = await cli(['app', 'create', '--name', 'Order Export (dev)', '--dev']);

      assert.equal(result.code, 0, result.stderr);
      const created = [...portal.apps.values()].find((app) => app.name === 'Order Export (dev)')!;
      assert.match(result.stdout, new RegExp(`Created Order Export \\(dev\\) \\(${created.appId}\\), unpublished`));
      assert.match(result.stdout, /The app secret, shown only now:\n {2}secret-\d+/);
      const { versionId, version, ...unversioned } = production;
      assert.deepEqual(JSON.parse(read('app-config.dev.json')), { ...unversioned, appId: created.appId });
      assert.equal(fs.existsSync(path.join(dir, '.env')), false);
      assert.deepEqual(portal.apiCalls().find((call) => call.method === 'POST')?.body, { name: 'Order Export (dev)' });
    });

    it('writes APP_ID and APP_SECRET to .env with --write-env, and never prints the secret', async () => {
      fs.writeFileSync(path.join(dir, '.env'), '# mine\nENCRYPTION_KEY=keep-me\nAPP_SECRET=old\n');

      const result = await cli(['app', 'create', '--name', 'Order Export (dev)', '--dev', '--write-env']);

      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /secret-\d/);
      assert.match(result.stdout, /Updated \.env with APP_ID and APP_SECRET/);
      const text = read('.env');
      assert.match(text, /^# mine\nENCRYPTION_KEY=keep-me\nAPP_SECRET=secret-\d+\n/);
      assert.match(text, /APP_ID=app\d{4}\n/);
    });

    it('creates a new .env readable only by you', async () => {
      assert.equal((await cli(['app', 'create', '--name', 'Fresh App', '--write-env'])).code, 0);
      assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    });

    it("asks for the name at a terminal, suggesting package.json's with (dev)", async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'order-export' }));
      let question = '';

      const result = await cli(['app', 'create', '--dev'], { prompt: async (text) => ((question = text), '') });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(question, 'App name (order-export (dev)): ');
      assert.ok([...portal.apps.values()].some((app) => app.name === 'order-export (dev)'));
    });

    it('needs --name without a terminal, and refuses a short name before calling the portal', async () => {
      assert.match((await cli(['app', 'create'])).stderr, /Name the app with --name/);
      assert.match((await cli(['app', 'create', '--name', 'ab'])).stderr, /at least 3 characters/);
      assert.match((await cli(['app', 'create', '--name', 'Valid', '--category', 'x'])).stderr, /--category takes a category ID/);
      assert.equal(portal.apiCalls().length, 0);
    });

    it("shows the portal's problems, and its refusal of a deploy token", async () => {
      const taken = await cli(['app', 'create', '--name', 'Order Export']);
      assert.equal(taken.code, 1);
      assert.match(taken.stderr, /name: The name has already been taken/);

      const deploy = await cli(['app', 'create', '--name', 'Another'], { env: { ...env, FLYCOMMERCE_TOKEN: portal.deployToken } });
      assert.match(deploy.stderr, /A deploy token only releases versions/);
    });
  });

  describe('app status', () => {
    it("shows versions, what the checklist needs and the developer's own stores", async () => {
      portal.addApp({
        appId: 'order-export',
        name: 'Order Export',
        versions: [
          { versionId: 1, version: '1.0.0', title: 'First', releasedAt: '2026-10-01T10:00:00Z' },
          { versionId: 2, version: '1.1.0', title: 'Next', releasedAt: null },
        ],
        checklist: [{ key: 'category', label: 'Category', hint: '', done: false, fixUrl: '' }],
        installs: [{ host: 'mine.flycom.shop', installedAt: '2026-10-02T08:00:00Z' }],
        devPushedAt: '2026-10-09T14:05:00Z',
      });

      const result = await cli(['app', 'status']);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Order Export \(order-export\), unpublished/);
      assert.match(result.stdout, /Live version\s+1\.0\.0 \(#1\), released 2026-10-01/);
      assert.match(result.stdout, /Waiting version\s+1\.1\.0 \(#2\), not released/);
      assert.match(result.stdout, /Review checklist\s+1 to do: category/);
      assert.match(result.stdout, /Installs\s+1 active\n.*\n.*\n.*\n\s+mine\.flycom\.shop {2}since 2026-10-02/);
      assert.match(result.stdout, /Last dev push\s+2026-10-09 14:05/);
    });

    it("shows only a count of a published app's installs", async () => {
      portal.addApp({
        appId: 'order-export',
        name: 'Order Export',
        status: 'published',
        installs: [{ host: 'merchant.flycom.shop', installedAt: '' }],
      });

      const result = await cli(['app', 'status']);

      assert.match(result.stdout, /Installs\s+1 active/);
      assert.doesNotMatch(result.stdout, /merchant\.flycom\.shop/);
    });
  });

  describe('app open', () => {
    it("refuses a link that isn't an https URL, so nothing but a web page reaches the system's opener", async () => {
      for (const bad of ['file:///System/Applications/Calculator.app', 'C:\\Windows\\System32\\calc.exe', 'javascript:alert(1)']) {
        portal.statusUrls = { portal: bad };
        const result = await cli(['app', 'open']);
        assert.equal(result.code, 1, bad);
      }
      portal.statusUrls = undefined;
      assert.deepEqual(opened, []);
    });

    it("opens the app's portal page, or the one --page names", async () => {
      assert.equal((await cli(['app', 'open'])).code, 0);
      assert.equal((await cli(['app', 'open', '--page', 'install'])).code, 0);
      assert.deepEqual(opened, [`${portal.url}/apps/1`, `${portal.url}/install/order-export`]);
      assert.match((await cli(['app', 'open', '--page', 'billing'])).stderr, /--page takes portal, versions, publishing, install/);
    });
  });

  describe('app secret rotate', () => {
    beforeEach(() => portal.addApp({ appId: 'order-export', name: 'Order Export' }));

    it("rotates an unpublished app's secret and shows the new one once", async () => {
      const result = await cli(['app', 'secret', 'rotate']);

      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Rotated order-export's secret\. The old one stopped working\.\nThe app secret, shown only now:\n {2}secret-\d+/
      );
    });

    it("asks before rotating a published app's secret, and needs --yes without a terminal", async () => {
      portal.addApp({ appId: 'order-export', name: 'Order Export', status: 'published' });

      const noTerminal = await cli(['app', 'secret', 'rotate']);
      assert.equal(noTerminal.code, 1);
      assert.match(noTerminal.stderr, /Pass --yes to rotate it anyway/);

      const declined = await cli(['app', 'secret', 'rotate'], { prompt: answer('n') });
      assert.match(declined.stderr, /Cancelled; the secret is unchanged/);

      const posts = () =>
        portal
          .apiCalls()
          .filter((call) => call.method === 'POST')
          .map((call) => call.body);
      assert.deepEqual(posts(), [{}, {}]);

      const confirmed = await cli(['app', 'secret', 'rotate'], { prompt: answer('y') });
      assert.equal(confirmed.code, 0, confirmed.stderr);
      assert.deepEqual(posts().slice(2), [{}, { confirm: true }]);

      portal.requests.length = 0;
      assert.equal((await cli(['app', 'secret', 'rotate', '--yes'])).code, 0);
      assert.deepEqual(posts(), [{ confirm: true }]);
    });

    it('writes the new secret to .env with --write-env, keeping the other lines', async () => {
      fs.writeFileSync(path.join(dir, '.env'), 'APP_ID=order-export\nAPP_SECRET=old\nPORT=4000\n');

      const result = await cli(['app', 'secret', 'rotate', '--write-env']);

      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /secret-\d/);
      assert.match(read('.env'), /^APP_ID=order-export\nAPP_SECRET=secret-\d+\nPORT=4000\n$/);
    });
  });

  describe('app token', () => {
    it('creates a deploy token named CI for 90 days by default, and shows it once', async () => {
      const result = await cli(['app', 'token', 'create']);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(portal.apiCalls().find((call) => call.method === 'POST')?.body, { name: 'CI', expiresInDays: 90 });
      assert.match(result.stdout, /The token, shown only now:\n {2}flyc_deploy_\d+\n.*FLYCOMMERCE_TOKEN/);
    });

    it('checks --expires and --name before calling the portal', async () => {
      assert.match((await cli(['app', 'token', 'create', '--expires', '45'])).stderr, /--expires takes 30, 90, 180/);
      assert.match((await cli(['app', 'token', 'create', '--name', 'x'.repeat(61)])).stderr, /up to 60 characters/);
      assert.equal(portal.apiCalls().length, 0);
    });

    it('lists the tokens without their values, and revokes one by ID', async () => {
      await cli(['app', 'token', 'create', '--name', 'GitHub Actions', '--expires', '30']);
      const id = portal.deployTokens.get('order-export')![0].id;

      const listed = await cli(['app', 'token', 'list']);
      assert.match(listed.stdout, new RegExp(`${id}\\s+GitHub Actions\\s+\\d{4}-\\d{2}-\\d{2}\\s+\\d{4}-\\d{2}-\\d{2}\\s+never`));
      assert.doesNotMatch(listed.stdout, /flyc_deploy/);

      const revoked = await cli(['app', 'token', 'revoke', String(id), '--yes']);
      assert.equal(revoked.code, 0, revoked.stderr);
      assert.match(revoked.stdout, new RegExp(`Revoked deploy token ${id} for order-export`));
      assert.equal(portal.deployTokens.get('order-export')!.length, 0);
      assert.match((await cli(['app', 'token', 'list'])).stdout, /has no deploy tokens/);
    });

    it('asks before revoking, needs an ID, and says when there is no such token', async () => {
      assert.match((await cli(['app', 'token', 'revoke', '7'])).stderr, /pass --yes to revoke/);
      assert.match((await cli(['app', 'token', 'revoke', '7'], { prompt: answer('no') })).stderr, /Cancelled; the token still works/);
      assert.match((await cli(['app', 'token', 'revoke', '--yes'])).stderr, /Name the token by its ID/);
      assert.match((await cli(['app', 'token', 'revoke', '7', '8', '--yes'])).stderr, /takes one token ID, not 7 8/);
      assert.match((await cli(['app', 'token', 'revoke', '7', '--yes'])).stderr, /has no deploy token 7/);
    });

    it('refuses a deploy token, as the portal does', async () => {
      const result = await cli(['app', 'token', 'list'], { env: { ...env, FLYCOMMERCE_TOKEN: portal.deployToken } });
      assert.match(result.stderr, /A deploy token can't manage deploy tokens/);
    });
  });

  describe('command names', () => {
    it('lists the new commands in the help, and prints it for an incomplete group', async () => {
      const help = await cli(['--help']);
      for (const command of [
        'init',
        'doctor',
        'env pull',
        'app create',
        'app status',
        'app open',
        'app secret rotate',
        'app token create',
      ]) {
        assert.match(help.stdout, new RegExp(`\\n {2}${command} `));
      }
      assert.equal((await cli(['app', 'token'])).code, 1);
      assert.equal((await cli(['env'])).code, 1);
      assert.match((await cli(['app', 'token', 'mint'])).stderr, /Unknown command: app token mint/);
    });

    it('takes init as app init, keeping its directory argument', async () => {
      assert.match((await cli(['init', '--help'])).stdout, /Usage: flycommerce app init/);
      assert.match((await cli(['init', 'one', 'two'])).stderr, /takes one directory, not one two/);
    });
  });

  describe('nothing lost or overwritten', () => {
    it('checks the local files before creating, so a broken config or an unreadable .env creates nothing', async () => {
      fs.writeFileSync(path.join(dir, 'app-config.json'), '{ broken');
      assert.match((await cli(['app', 'create', '--name', 'Broken Link', '--dev'])).stderr, /app-config\.json is not valid JSON/);

      fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(production));
      fs.mkdirSync(path.join(dir, '.env'));
      assert.match((await cli(['app', 'create', '--name', 'Env Dir', '--write-env'])).stderr, /Can't read \.env/);

      assert.equal(portal.apiCalls().filter((call) => call.method === 'POST').length, 0);
    });

    it("refuses --write-env when .env holds another app's APP_ID, before anything changes on the portal", async () => {
      fs.writeFileSync(path.join(dir, '.env'), 'APP_ID=production-app\nAPP_SECRET=keep-me\n');

      const create = await cli(['app', 'create', '--name', 'Dev App', '--dev', '--write-env']);
      assert.match(create.stderr, /already holds APP_ID production-app/);

      portal.addApp({ appId: 'order-export', name: 'Order Export' });
      const rotate = await cli(['app', 'secret', 'rotate', '--write-env']);
      assert.match(rotate.stderr, /already holds APP_ID production-app/);

      assert.equal(portal.apiCalls().filter((call) => call.method === 'POST').length, 0);
      assert.equal(read('.env'), 'APP_ID=production-app\nAPP_SECRET=keep-me\n');
    });

    it('shows the secret when writing .env fails after the portal created it', async () => {
      fs.writeFileSync(path.join(dir, '.env'), 'PORT=4000\n');
      fs.chmodSync(path.join(dir, '.env'), 0o444);

      const result = await cli(['app', 'create', '--name', 'Read Only Env', '--write-env']);

      fs.chmodSync(path.join(dir, '.env'), 0o644);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /The app secret, shown only now:\n {2}secret-\d+/);
      assert.match(result.stderr, /Couldn't write \.env: .*The secret is above, shown this once/);
    });

    it('writes APP_ID with a rotated secret, and warns about a .env others can read', async () => {
      portal.addApp({ appId: 'order-export', name: 'Order Export' });
      fs.writeFileSync(path.join(dir, '.env'), 'PORT=4000\n', { mode: 0o644 });
      fs.chmodSync(path.join(dir, '.env'), 0o644);

      const result = await cli(['app', 'secret', 'rotate', '--write-env']);

      assert.equal(result.code, 0, result.stderr);
      assert.match(read('.env'), /APP_ID=order-export\nAPP_SECRET=secret-\d+\n/);
      assert.match(result.stdout, /other users on this computer can read \.env \(mode 644\)/);
    });
  });

  it('says to put the command first when an option comes before it', async () => {
    const result = await runCli(['--portal', portal.url, 'app', 'list'], { env, cwd: dir });
    assert.match(result.stderr, /Put the command first/);
  });
});
