import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { tunnelUrlFromLine } from '../tunnel.js';
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
  `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({ APP_URL: process.env.APP_URL, REDIRECT_URI: process.env.REDIRECT_URI, PORT: process.env.PORT, APP_CONFIG_FILE: process.env.APP_CONFIG_FILE, FLYCOMMERCE_TOKEN: process.env.FLYCOMMERCE_TOKEN ?? null, pid: process.pid }));` +
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
    portal.devPushAnswer = { reinstallRequired: false };
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
      FLYCOMMERCE_TOKEN: null,
      pid: JSON.parse(fs.readFileSync(out, 'utf8')).pid,
    });
    assert.match(result.stdout, new RegExp(`Install it on your store:\\s+${portal.url}/apps/order-export-dev/install`));
    assert.match(result.stdout, /Export orders\s+https:\/\/my-tunnel\.example\.dev\/export/);
    assert.match(result.stdout, /welcome\s+https:\/\/my-tunnel\.example\.dev\/storefront\/welcome\.js/);
  });

  it('refuses a dev config without appUrl, which the server loading the same file would refuse too', async () => {
    const { appUrl, ...withoutAppUrl } = devConfig;
    fs.writeFileSync(path.join(dir, 'app-config.dev.json'), JSON.stringify(withoutAppUrl));

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', process.execPath, '-e', ''],
      { env, cwd: dir }
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /app-config\.dev\.json is not valid:\n  - appUrl is required/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });

  it("runs a server that loads the same config with @flycommerce/app-server's loadAppConfig", async () => {
    const out = path.join(dir, 'loaded.json');
    const appServer = import.meta.resolve('@flycommerce/app-server');
    const server = `const { loadAppConfig } = await import(${JSON.stringify(appServer)});
      const config = loadAppConfig(process.env.APP_CONFIG_FILE, { appId: 'order-export-dev' });
      (await import('node:fs')).writeFileSync(${JSON.stringify(out)}, JSON.stringify({ appId: config.appId, pages: config.dashboard.pages.length }));`;

    const result = await runCli(
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--tunnel-url',
        'https://t.example.dev',
        '--portal',
        portal.url,
        '--',
        process.execPath,
        '--input-type=module',
        '-e',
        server,
      ],
      { env, cwd: dir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { appId: 'order-export-dev', pages: 1 });
  });

  it('sets REDIRECT_URI to the redirect URL the hub now holds, exactly, and says when the app must be reinstalled', async () => {
    const out = path.join(dir, 'env.json');
    portal.devPushAnswer = { reinstallRequired: true, redirectUrl: 'https://Dev.Example.dev/auth/callback' };

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://Dev.Example.dev', '--portal', portal.url, '--', ...recordEnv(out)],
      { env, cwd: dir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).REDIRECT_URI, 'https://Dev.Example.dev/auth/callback');
    assert.match(result.stdout, /Reinstall the app on your store to grant the permissions this config adds/);

    portal.devPushAnswer = {
      reinstallRequired: true,
      redirectUrl: 'https://dev.example.dev/hub/kept',
      message: 'Reinstall to grant: storefront.scripts\u001b[2J',
    };
    const again = await runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://Dev.Example.dev', '--portal', portal.url, '--', ...recordEnv(out)],
      { env, cwd: dir }
    );

    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).REDIRECT_URI, 'https://dev.example.dev/hub/kept');
    assert.match(again.stdout, /Reinstall to grant: storefront\.scripts\[2J/);
    assert.ok(!again.stdout.includes('\u001b'), 'no terminal escapes from the network');
  });

  it("falls back to the config's redirect on the tunnel when the hub holds none", async () => {
    const out = path.join(dir, 'env.json');
    portal.devPushAnswer = { reinstallRequired: false, redirectUrl: null };

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', ...recordEnv(out)],
      { env, cwd: dir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).REDIRECT_URI, 'https://t.example.dev/auth/callback');
    assert.doesNotMatch(result.stdout, /Reinstall/);
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

  const fakeCloudflared = (script: string) => {
    const fake = path.join(dir, 'cloudflared');
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, 'cloudflared.json'))}, JSON.stringify({ pid: process.pid, token: process.env.FLYCOMMERCE_TOKEN ?? null }));\n` +
        script,
      { mode: 0o755 }
    );
    return fake;
  };
  const cloudflaredRun = () => JSON.parse(fs.readFileSync(path.join(dir, 'cloudflared.json'), 'utf8'));

  it('starts cloudflared for a quick tunnel, uses its URL, and stops it afterwards', async () => {
    const out = path.join(dir, 'env.json');
    const fake = fakeCloudflared(
      `if (process.argv.slice(2).join(' ') !== 'tunnel --no-autoupdate --url http://localhost:4200') process.exit(2);\n` +
        `console.error('2026-10-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');\n` +
        `console.error('2026-10-06T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');\n` +
        `console.error('2026-10-06T10:00:01Z INF |  https://quiet-fox-lamp.trycloudflare.com                                                  |');\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const result = await runCli(['app', 'dev', '--config', 'dev', '--port', '4200', '--portal', portal.url, '--', ...recordEnv(out)], {
      env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).APP_URL, 'https://quiet-fox-lamp.trycloudflare.com');
    assert.equal(portal.apiCalls().find((call) => call.method === 'PUT')!.body.config.appUrl, 'https://quiet-fox-lamp.trycloudflare.com');
    const { pid, token } = cloudflaredRun();
    assert.equal(token, null, 'cloudflared never gets the portal token');
    await waitFor(() => (alive(pid) ? undefined : true));
  });

  it('fails, and pushes nothing, when cloudflared cannot create a tunnel', async () => {
    const fake = fakeCloudflared(
      `console.error('2026-10-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');\n` +
        `console.error('2026-10-06T10:00:01Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host');\n` +
        `process.exit(1);\n`
    );

    const result = await runCli(['app', 'dev', '--config', 'dev', '--portal', portal.url, '--', process.execPath, '-e', ''], {
      env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
      cwd: dir,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /cloudflared stopped before it gave a tunnel URL:[^]*failed to request quick Tunnel/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });

  it('stops the server with an error when the tunnel dies', { timeout: 10_000 }, async () => {
    const out = path.join(dir, 'env.json');
    const fake = fakeCloudflared(
      `console.error('INF |  https://short-lived.trycloudflare.com  |');\nsetTimeout(() => process.exit(1), 300);\nsetInterval(() => {}, 1000);\n`
    );

    const running = runCli(['app', 'dev', '--config', 'dev', '--portal', portal.url, '--', ...recordEnv(out, true)], {
      env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
      cwd: dir,
    });
    const { pid } = await waitFor(() => (fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined));
    // Without the fix the server would run on forever; this ends it so the test fails instead of hanging.
    const watchdog = setTimeout(() => alive(pid) && process.kill(pid, 'SIGKILL'), 4000);

    try {
      const stoppedByCli = await waitFor(() => (alive(pid) ? undefined : true), 3000).then(
        () => true,
        () => false
      );
      const result = await running;
      assert.ok(stoppedByCli, 'the server was stopped when the tunnel died');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /The tunnel stopped/);
    } finally {
      clearTimeout(watchdog);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
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

describe("reading cloudflared's output", () => {
  it('takes the tunnel URL only from a line of its own, never the API cloudflared calls', () => {
    assert.equal(
      tunnelUrlFromLine('2026-10-06T10:00:01Z INF |  https://quiet-fox-lamp.trycloudflare.com          |'),
      'https://quiet-fox-lamp.trycloudflare.com'
    );
    assert.equal(tunnelUrlFromLine('https://quiet-fox-lamp.trycloudflare.com'), 'https://quiet-fox-lamp.trycloudflare.com');
    assert.equal(tunnelUrlFromLine('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), undefined);
    assert.equal(tunnelUrlFromLine('INF |  https://api.trycloudflare.com  |'), undefined);
    assert.equal(tunnelUrlFromLine('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
    assert.equal(tunnelUrlFromLine('INF see https://evil.trycloudflare.com.example.net |'), undefined);
  });
});
