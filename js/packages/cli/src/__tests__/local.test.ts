import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, it } from 'node:test';
import { run } from '../main.js';

const config = {
  appId: 'order-export',
  versionId: 2,
  version: '1.1.0',
  appUrl: 'https://export.example.com',
  install: { redirectUrl: '/auth/callback' },
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
  storefront: { scripts: [{ handle: 'welcome', src: '/storefront/welcome.js' }] },
};

// A stand-in for the app's server: records its environment and the install callback, as a real app would receive them.
const server = [
  process.execPath,
  '-e',
  `const http = require('http'); const fs = require('fs');
   http.createServer((req, res) => {
     if (req.url.startsWith('/auth/callback')) {
       const keys = ['APP_ID', 'APP_SECRET', 'HUB_API_URL', 'JWKS_URL', 'ALLOWED_ISSUERS', 'STORE_BASE_URL', 'FRAME_ANCESTORS', 'APP_URL', 'REDIRECT_URI', 'PORT', 'APP_CONFIG_FILE', 'FLYCOMMERCE_TOKEN'];
       fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ callback: req.url, env: Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])) }));
       res.writeHead(302, { Location: '/export' });
       return res.end();
     }
     res.end('ok');
   }).listen(Number(process.env.PORT), '127.0.0.1');`,
];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

describe('flycommerce app dev --local', () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-local-'));
    out = path.join(dir, 'server.json');
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(config));
  });

  function start(argv: string[], env: NodeJS.ProcessEnv = {}) {
    const controller = new AbortController();
    const output = { stdout: '', stderr: '' };
    const done = run(['app', 'dev', '--local', ...argv], {
      // No sign-in and a portal that can't be reached: local mode never needs either.
      env: {
        XDG_CONFIG_HOME: dir,
        OUT_FILE: out,
        FLYCOMMERCE_PORTAL_URL: 'https://unreachable.invalid',
        FLYCOMMERCE_TOKEN: 'flyc_should_not_leak',
        ...env,
      },
      cwd: dir,
      stdout: (text) => (output.stdout += `${text}\n`),
      stderr: (text) => (output.stderr += `${text}\n`),
      openUrl: () => {},
      signal: controller.signal,
    });
    return { done, output, stop: () => controller.abort() };
  }

  it('runs the server against the emulator, installs the app once it listens, and prints the links', async () => {
    const port = await freePort();
    const { done, output, stop } = start(['--port', String(port), '--', ...server]);

    await until(() => output.stdout.includes('Store API'));
    const recorded = JSON.parse(fs.readFileSync(out, 'utf8'));
    stop();
    assert.equal(await done, 0, output.stderr);

    const { env } = recorded;
    assert.match(recorded.callback, /^\/auth\/callback\?.*code=/);
    assert.equal(env.APP_ID, 'order-export');
    assert.match(env.APP_SECRET, /^[0-9a-f]{48}$/);
    for (const key of ['HUB_API_URL', 'JWKS_URL', 'ALLOWED_ISSUERS', 'STORE_BASE_URL', 'FRAME_ANCESTORS']) {
      assert.match(env[key], /^http:\/\/127\.0\.0\.1:\d+/, key);
    }
    assert.equal(env.APP_URL, `http://localhost:${port}`);
    assert.equal(env.REDIRECT_URI, `http://localhost:${port}/auth/callback`);
    assert.equal(env.PORT, String(port));
    assert.equal(env.APP_CONFIG_FILE, path.join(dir, 'app-config.json'));
    assert.equal(env.FLYCOMMERCE_TOKEN, null);

    assert.match(output.stdout, /Installed order-export on local\.flycom\.shop with catalog\.read, orders\.read/);
    assert.ok(output.stdout.includes(`Dashboard   ${env.FRAME_ANCESTORS}/apps/export`), output.stdout);
    assert.match(output.stdout, /Storefront {2}http:\/\/127\.0\.0\.1:\d+\/storefront/);
    assert.doesNotMatch(output.stdout, /Your install callback answered/);
  });

  it('grants the permissions --scopes names', async () => {
    const port = await freePort();
    const { done, output, stop } = start(['--port', String(port), '--scopes', 'orders.read', '--', ...server]);

    await until(() => output.stdout.includes('Store API'));
    stop();
    await done;

    assert.match(output.stdout, /with orders\.read\.\n/);
  });

  it("reports a server that stops before it listens, with the server's exit code", async () => {
    const { done, output } = start(['--port', String(await freePort()), '--', process.execPath, '-e', 'process.exit(3)']);

    assert.equal(await done, 3);
    await until(() => output.stderr.includes('stopped before it listened'));
  });

  it('refuses a tunnel with --local, and --scopes without it', async () => {
    const tunnel = start(['--tunnel-url', 'https://x.example']);
    assert.equal(await tunnel.done, 1);
    assert.match(tunnel.output.stderr, /--local runs without a tunnel/);

    let stderr = '';
    const code = await run(['app', 'dev', '--scopes', 'orders.read'], {
      env: { XDG_CONFIG_HOME: dir },
      cwd: dir,
      stdout: () => {},
      stderr: (text) => (stderr += text),
      openUrl: () => {},
    });
    assert.equal(code, 1);
    assert.match(stderr, /--scopes is for --local/);
  });
});
