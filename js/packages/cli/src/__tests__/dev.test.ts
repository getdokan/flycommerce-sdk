import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// Cloudflare's side of a tunnel that works: every request reaches the port on this computer.
const throughTunnel =
  (port: number): typeof fetch =>
  (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
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
  let port: number;

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(async () => {
    port = await freePort();
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
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--tunnel-url', tunnel, '--portal', portal.url, '--', ...recordEnv(out)],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
    );

    assert.equal(result.code, 0, result.stderr);
    const push = portal.apiCalls().find((call) => call.method === 'PUT')!;
    assert.equal(push.path, '/api/cli/v1/apps/order-export-dev/dev-config');
    assert.deepEqual(push.body.config, { ...devConfig, appUrl: 'https://my-tunnel.example.dev' }, 'paths are left for the hub; no version');

    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
      APP_URL: 'https://my-tunnel.example.dev',
      REDIRECT_URI: 'https://my-tunnel.example.dev/auth/callback',
      PORT: String(port),
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
        '--port',
        String(port),
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
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { appId: 'order-export-dev', pages: 1 });
  });

  it('sets REDIRECT_URI to the redirect URL the hub now holds, exactly, and says when the app must be reinstalled', async () => {
    const out = path.join(dir, 'env.json');
    portal.devPushAnswer = { reinstallRequired: true, redirectUrl: 'https://Dev.Example.dev/auth/callback' };

    const result = await runCli(
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--port',
        String(port),
        '--tunnel-url',
        'https://Dev.Example.dev',
        '--portal',
        portal.url,
        '--',
        ...recordEnv(out),
      ],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
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
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--port',
        String(port),
        '--tunnel-url',
        'https://Dev.Example.dev',
        '--portal',
        portal.url,
        '--',
        ...recordEnv(out),
      ],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
    );

    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).REDIRECT_URI, 'https://dev.example.dev/hub/kept');
    assert.match(again.stdout, /Reinstall to grant: storefront\.scripts\n/);
    assert.ok(!again.stdout.includes('\u001b'), 'no terminal escapes from the network');
  });

  it("falls back to the config's redirect on the tunnel when the hub holds none", async () => {
    const out = path.join(dir, 'env.json');
    portal.devPushAnswer = { reinstallRequired: false, redirectUrl: null };

    const result = await runCli(
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--port',
        String(port),
        '--tunnel-url',
        'https://t.example.dev',
        '--portal',
        portal.url,
        '--',
        ...recordEnv(out),
      ],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
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
        ['app', 'dev', '--port', String(port), '--tunnel-url', 'https://t.example.dev', '--portal', portal.url, '--', ...recordEnv(out)],
        { env, cwd: dir, tunnelFetch: throughTunnel(port) }
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
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--port',
        String(port),
        '--tunnel-url',
        'https://t.example.dev',
        '--portal',
        portal.url,
        '--',
        ...recordEnv(out, true),
      ],
      { env, cwd: dir, signal: controller.signal, tunnelFetch: throughTunnel(port) }
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
      `#!${process.execPath}\nconst args = process.argv.slice(2), at = args.indexOf('--config');\n` +
        `const config = at === -1 ? null : require('fs').readFileSync(args[at + 1], 'utf8');\n` +
        `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'cloudflared.json'))}, JSON.stringify({ pid: process.pid, token: process.env.FLYCOMMERCE_TOKEN ?? null, args, config }));\n` +
        script,
      { mode: 0o755 }
    );
    return fake;
  };
  const cloudflaredRun = () => JSON.parse(fs.readFileSync(path.join(dir, 'cloudflared.json'), 'utf8'));

  it('starts cloudflared for a quick tunnel, uses its URL, and stops it afterwards', async () => {
    const out = path.join(dir, 'env.json');
    const fake = fakeCloudflared(
      `if (args[0] !== 'tunnel' || args.slice(3).join(' ') !== '--no-autoupdate --url http://localhost:${port}') process.exit(2);\n` +
        `console.error('2026-10-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');\n` +
        `console.error('2026-10-06T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');\n` +
        `console.error('2026-10-06T10:00:01Z INF |  https://quiet-fox-lamp.trycloudflare.com                                                  |');\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', ...recordEnv(out)],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        tunnelFetch: throughTunnel(port),
      }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).APP_URL, 'https://quiet-fox-lamp.trycloudflare.com');
    assert.equal(portal.apiCalls().find((call) => call.method === 'PUT')!.body.config.appUrl, 'https://quiet-fox-lamp.trycloudflare.com');
    const { pid, token } = cloudflaredRun();
    assert.equal(token, null, 'cloudflared never gets the portal token');
    await waitFor(() => (alive(pid) ? undefined : true));
  });

  it("runs cloudflared with an empty config of its own, so a config.yml's ingress rules can't take over the quick tunnel", async () => {
    const fake = fakeCloudflared(`console.error('INF |  https://quiet-fox-lamp.trycloudflare.com  |');\nsetInterval(() => {}, 1000);\n`);

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', process.execPath, '-e', ''],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        tunnelFetch: throughTunnel(port),
      }
    );

    assert.equal(result.code, 0, result.stderr);
    const { pid, args, config } = cloudflaredRun();
    assert.deepEqual(args.slice(0, 2), ['tunnel', '--config'], '--config is a tunnel option, before --url');
    assert.deepEqual(args.slice(3), ['--no-autoupdate', '--url', `http://localhost:${port}`]);
    assert.deepEqual(JSON.parse(config), {}, 'YAML with no ingress, and not empty, which cloudflared logs as an error');
    await waitFor(() => (alive(pid) ? undefined : true));
    await waitFor(() => (fs.existsSync(args[2]) ? undefined : true));
  });

  it('stops before pushing when the tunnel answers with something other than the app, and names the likely config.yml', async () => {
    const out = path.join(dir, 'env.json');
    const fake = fakeCloudflared(`console.error('INF |  https://quiet-fox-lamp.trycloudflare.com  |');\nsetInterval(() => {}, 1000);\n`);
    const seen: string[] = [];

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', ...recordEnv(out)],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        // What a named tunnel's ingress list answers for a host it doesn't know.
        tunnelFetch: async (input) => (seen.push(String(input)), new Response('Not Found', { status: 404 })),
      }
    );

    assert.equal(result.code, 1);
    assert.ok(seen.every((url) => url.startsWith('https://quiet-fox-lamp.trycloudflare.com/')));
    assert.match(result.stderr, /https:\/\/quiet-fox-lamp\.trycloudflare\.com doesn't reach port \d+ on this computer: it answered 404/);
    assert.match(result.stderr, /ingress rules[^]*~\/\.cloudflared\/config\.yml/);
    assert.doesNotMatch(result.stdout, /Pushed|Install it on your store/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'), 'nothing is pushed');
    assert.ok(!fs.existsSync(out), 'the server is not started');
  });

  it('waits for a quick tunnel to start answering, then says so when it never does', async () => {
    const fake = fakeCloudflared(`console.error('INF |  https://quiet-fox-lamp.trycloudflare.com  |');\nsetInterval(() => {}, 1000);\n`);
    let calls = 0;
    // Cloudflare answers 530 until the tunnel is registered; DNS for the new host can fail for a while too.
    const slowTunnel: typeof fetch = async (input, init) => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('error code: 1033', { status: 530 });
      return throughTunnel(port)(input, init);
    };

    const ready = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', process.execPath, '-e', ''],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        tunnelFetch: slowTunnel,
      }
    );
    assert.equal(ready.code, 0, ready.stderr);
    assert.equal(calls, 3);

    portal.requests.length = 0;
    const never = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', process.execPath, '-e', ''],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        tunnelFetch: async () => {
          throw new TypeError('fetch failed');
        },
        tunnelCheckTimeoutMs: 300,
      }
    );
    assert.equal(never.code, 1);
    assert.match(never.stderr, /quiet-fox-lamp\.trycloudflare\.com didn't answer within 0\.3 seconds/);
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });

  it('checks a --tunnel-url tunnel too, pointing at its ingress rules', async () => {
    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--tunnel-url', 'https://dev.example.dev', '--portal', portal.url],
      { env, cwd: dir, tunnelFetch: async () => new Response('<h1>Another app</h1>', { status: 200 }) }
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /https:\/\/dev\.example\.dev doesn't reach port \d+ on this computer: it answered 200 with another page/);
    assert.match(result.stderr, new RegExp(`sends requests to http://localhost:${port}`));
    assert.ok(!portal.apiCalls().some((call) => call.method === 'PUT'));
  });

  it("warns, and goes on, when something already listens on the port, since the tunnel can't be checked", async () => {
    const busy = net.createServer((socket) => socket.end()).listen(port, '127.0.0.1');
    await new Promise((resolve) => busy.once('listening', resolve));

    try {
      const result = await runCli(
        [
          'app',
          'dev',
          '--config',
          'dev',
          '--port',
          String(port),
          '--tunnel-url',
          'https://t.example.dev',
          '--portal',
          portal.url,
          '--',
          process.execPath,
          '-e',
          '',
        ],
        { env, cwd: dir, tunnelFetch: async () => new Response('Not Found', { status: 404 }) }
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`Warning: something is already listening on port ${port}, so the tunnel wasn't checked`));
      assert.ok(portal.apiCalls().some((call) => call.method === 'PUT'));
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
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
      `console.error('INF |  https://short-lived.trycloudflare.com  |');\nsetTimeout(() => process.exit(1), 1500);\nsetInterval(() => {}, 1000);\n`
    );

    const running = runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--portal', portal.url, '--', ...recordEnv(out, true)],
      {
        env: { ...env, FLYCOMMERCE_CLOUDFLARED: fake },
        cwd: dir,
        tunnelFetch: throughTunnel(port),
      }
    );
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

  it("moves URLs on the app's port on this computer onto the tunnel, as app init's example writes them", async () => {
    const local = `http://localhost:${port}`;
    fs.writeFileSync(
      path.join(dir, 'app-config.dev.json'),
      JSON.stringify({
        ...devConfig,
        appUrl: local,
        install: { redirectUrl: `${local}/auth/callback?from=install` },
        storefront: { scripts: [{ handle: 'welcome', src: `${local}/storefront/welcome.js`, load: 'idle' }] },
      })
    );

    const result = await runCli(
      [
        'app',
        'dev',
        '--config',
        'dev',
        '--port',
        String(port),
        '--tunnel-url',
        'https://t.example.dev',
        '--portal',
        portal.url,
        '--',
        process.execPath,
        '-e',
        '',
      ],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
    );

    assert.equal(result.code, 0, result.stderr);
    const pushed = portal.apiCalls().find((call) => call.method === 'PUT')!.body.config;
    assert.equal(pushed.appUrl, 'https://t.example.dev');
    assert.deepEqual(pushed.storefront.scripts, [{ handle: 'welcome', src: 'https://t.example.dev/storefront/welcome.js', load: 'idle' }]);
    assert.equal(pushed.install.redirectUrl, 'https://t.example.dev/auth/callback?from=install');
    assert.match(result.stdout, /welcome\s+https:\/\/t\.example\.dev\/storefront\/welcome\.js/);
  });

  it("leaves a URL on another port of this computer for the check, since the tunnel doesn't reach it", async () => {
    fs.writeFileSync(
      path.join(dir, 'app-config.dev.json'),
      JSON.stringify({
        ...devConfig,
        appUrl: `http://localhost:${port}`,
        storefront: { scripts: [{ handle: 'welcome', src: `http://localhost:${port + 1}/w.js` }] },
      })
    );

    const result = await runCli(
      ['app', 'dev', '--config', 'dev', '--port', String(port), '--tunnel-url', 'https://t.example.dev', '--portal', portal.url],
      { env, cwd: dir, tunnelFetch: throughTunnel(port) }
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /storefront\.scripts\[0\]\.src must be on t\.example\.dev[^]*Write each script src as a path/);
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

  it('reads it from coloured output and from JSON logs, with the same rule', () => {
    const url = 'https://foo-bar-baz.trycloudflare.com';
    assert.equal(tunnelUrlFromLine(`\u001b[90m2026-10-06T10:00:00Z\u001b[0m \u001b[32mINF\u001b[0m |  ${url}  |`), url);
    assert.equal(tunnelUrlFromLine(`|  ${url}  |\r`), url);
    assert.equal(tunnelUrlFromLine(`{"level":"info","time":"2026-10-06T10:00:00Z","message":"|  ${url}  |"}`), url);
    assert.equal(tunnelUrlFromLine(`{"level":"info","message":"${url}"}`), url);
    assert.equal(
      tunnelUrlFromLine('{"level":"error","message":"failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\""}'),
      undefined
    );
    assert.equal(tunnelUrlFromLine('{"level":"info","message":"|  https://api.trycloudflare.com  |"}'), undefined);
    assert.equal(tunnelUrlFromLine(`{"level":"info","url":"${url}"}`), undefined);
    assert.equal(tunnelUrlFromLine(`{"message": broken ${url}`), undefined);
  });
});
