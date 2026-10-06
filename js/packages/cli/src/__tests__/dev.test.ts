import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakePortal, runCli } from './fake-portal.js';

const devConfig = {
  appId: 'order-export-dev',
  appUrl: 'https://export.example.com',
  install: { redirectUrl: '/auth/callback' },
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
  storefront: { scripts: [{ handle: 'welcome', src: '/storefront/welcome.js' }] },
};

// A stand-in for the app's server: records the environment it was started with.
const recordEnv = (file: string, linger = false) => [
  process.execPath,
  '-e',
  `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({ APP_URL: process.env.APP_URL, REDIRECT_URI: process.env.REDIRECT_URI, PORT: process.env.PORT, APP_CONFIG_FILE: process.env.APP_CONFIG_FILE, pid: process.pid }));` +
    (linger ? 'setInterval(() => {}, 1000);' : ''),
];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await sleep(20);
  }
}

describe('flycommerce app dev', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-dev-'));
    env = { PATH: process.env.PATH, XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: portal.token };
    portal.apps.clear();
    portal.requests.length = 0;
    portal.addApp({ appId: 'order-export', name: 'Order Export', published: true, status: 'published' });
    portal.addApp({ appId: 'order-export-dev', name: 'Order Export (dev)' });
    fs.writeFileSync(path.join(dir, 'app-config.dev.json'), JSON.stringify({ ...devConfig, versionId: 2, version: '1.0.0' }));
  });

  it('pushes the config with the tunnel as appUrl, then runs the server with APP_URL, REDIRECT_URI and PORT', async () => {
    const out = path.join(dir, 'env.json');
    const tunnel = 'https://my-tunnel.example.dev/';
    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', '4100', '--tunnel-url', tunnel, '--portal', portal.url, '--', ...recordEnv(out)],
      { env, cwd: dir }
    );

    assert.equal(result.code, 0, result.stderr);
    const push = portal.apiCalls().find((call) => call.method === 'PUT')!;
    assert.equal(push.path, '/api/cli/v1/apps/order-export-dev/dev-config');
    assert.deepEqual(push.body.config, { ...devConfig, appUrl: 'https://my-tunnel.example.dev' }, 'paths are left for the hub; no version');

    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
      APP_URL: 'https://my-tunnel.example.dev',
      REDIRECT_URI: 'https://my-tunnel.example.dev/auth/callback',
      PORT: '4100',
      APP_CONFIG_FILE: path.join(dir, 'app-config.dev.json'),
      pid: JSON.parse(fs.readFileSync(out, 'utf8')).pid,
    });
    assert.match(result.stdout, new RegExp(`Install it on your store:\\s+${portal.url}/apps/order-export-dev/install`));
    assert.match(result.stdout, /Export orders\s+https:\/\/my-tunnel\.example\.dev\/export/);
    assert.match(result.stdout, /welcome\s+https:\/\/my-tunnel\.example\.dev\/storefront\/welcome\.js/);
  });

  it('takes a dev config without appUrl, since the tunnel replaces it', async () => {
    const { appUrl, ...withoutAppUrl } = devConfig;
    fs.writeFileSync(path.join(dir, 'app-config.dev.json'), JSON.stringify(withoutAppUrl));

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', process.execPath, '-e', ''],
      { env, cwd: dir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(portal.apiCalls().find((call) => call.method === 'PUT')!.body.config.appUrl, 'https://t.example.dev');
  });

  for (const status of ['published', 'pending'] as const) {
    it(`refuses a ${status} app and runs nothing`, async () => {
      const out = path.join(dir, 'env.json');
      portal.apps.get('order-export')!.status = status;
      fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ ...devConfig, appId: 'order-export' }));

      const result = await runCli(
        ['app', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', ...recordEnv(out)],
        {
          env,
          cwd: dir,
        }
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Error: Order Export (is published|is waiting for review), so it only changes by releasing a version/);
      assert.match(result.stderr, /- Use a development app: flycommerce app link --config dev/);
      assert.ok(!fs.existsSync(out));
    });
  }

  it('stops the server on Ctrl+C', { timeout: 10_000 }, async () => {
    const out = path.join(dir, 'env.json');
    const controller = new AbortController();
    const running = runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', ...recordEnv(out, true)],
      { env, cwd: dir, signal: controller.signal }
    );

    const { pid } = await waitFor(() => (fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined));

    try {
      assert.ok(alive(pid));
      controller.abort();
      await waitFor(() => (alive(pid) ? undefined : true), 3000);
      assert.equal((await running).code, 0);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('starts cloudflared for a quick tunnel, uses its URL, and stops it afterwards', async () => {
    const out = path.join(dir, 'env.json');
    const pidFile = path.join(dir, 'cloudflared.pid');
    const fake = path.join(dir, 'cloudflared');
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `if (process.argv.slice(2).join(' ') !== 'tunnel --no-autoupdate --url http://localhost:4200') process.exit(2);\n` +
        `console.error('INF |  https://quiet-fox-lamp.trycloudflare.com  |');\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 }
    );

    const result = await runCli(['app', 'dev', '--config', 'dev', '--port', '4200', '--portal', portal.url, '--', ...recordEnv(out)], {
      env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).APP_URL, 'https://quiet-fox-lamp.trycloudflare.com');
    assert.equal(portal.apiCalls().find((call) => call.method === 'PUT')!.body.config.appUrl, 'https://quiet-fox-lamp.trycloudflare.com');
    const tunnelPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => (alive(tunnelPid) ? undefined : true));
  });

  it("says how to go on when cloudflared isn't installed", async () => {
    const result = await runCli(['app', 'dev', '--config', 'dev', '--portal', portal.url], {
      env: { ...env, FLYCOMMERCE_CLOUDFLARED: path.join(dir, 'no-such-cloudflared') },
      cwd: dir,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /cloudflared isn't installed[^]*--tunnel-url/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });

  it('suggests a path when a script src is pinned to another host', async () => {
    fs.writeFileSync(
      path.join(dir, 'app-config.dev.json'),
      JSON.stringify({ ...devConfig, storefront: { scripts: [{ handle: 'welcome', src: 'https://export.example.com/welcome.js' }] } })
    );

    const result = await runCli(['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url], {
      env,
      cwd: dir,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /must be on t\.example\.dev[^]*Write each script src as a path/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });
});
