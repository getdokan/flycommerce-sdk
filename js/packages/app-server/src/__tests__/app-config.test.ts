import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, AppConfigError, checkAppConfig, loadAppConfig, pagePaths } from '../app-config.js';
import { serveWebApp } from '../static.js';

const valid: AppConfig = {
  appId: 'app-123',
  versionId: 12,
  version: '1.11.0',
  quote: 'World is a beautiful place',
  appUrl: 'https://crm.example.com',
  dashboard: {
    pages: [
      { slug: 'overview', label: 'Overview', path: '/overview' },
      { slug: 'settings', label: 'Settings', path: '/settings', children: [{ slug: 'team', label: 'Team', path: '/settings/team' }] },
    ],
  },
};

const withChanges = (changes: Record<string, unknown>) => ({ ...valid, ...changes });

const write = (value: unknown) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'app-config-')), 'app-config.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

describe('app-config.json', () => {
  it('accepts a valid file and lists every page path, sub-pages included', () => {
    assert.deepStrictEqual(checkAppConfig(valid), []);
    assert.deepStrictEqual(pagePaths(valid), ['/overview', '/settings', '/settings/team']);
    assert.deepStrictEqual(loadAppConfig(write(valid), { appId: 'app-123' }), valid);
  });

  it('allows plain http only for local development', () => {
    assert.deepStrictEqual(checkAppConfig(withChanges({ appUrl: 'http://localhost:4600' })), []);
    assert.match(checkAppConfig(withChanges({ appUrl: 'http://crm.example.com' })).join(), /https/);
  });

  it('names every problem at once', () => {
    const problems = checkAppConfig(
      withChanges({
        versionId: '12',
        version: 'v2',
        notice: 'hello',
        dashboard: {
          pages: [
            { slug: 'overview', label: 'Overview', path: 'overview' },
            { slug: 'overview', label: 'Again', path: '/again', children: [{ slug: 'x', label: 'X', path: '/x', children: [] }] },
          ],
        },
      })
    ).join('\n');

    assert.match(problems, /Unknown keys: notice/);
    assert.match(problems, /versionId must be a whole number/);
    assert.match(problems, /version must be three numbers/);
    assert.match(problems, /dashboard\.pages\[0\]\.path must start with \//);
    assert.match(problems, /pages nest one level deep/);
    assert.match(problems, /repeated: overview/);
  });

  it('stops the app when the file belongs to another app or is not JSON', () => {
    assert.throws(
      () => loadAppConfig(write(valid), { appId: 'another-app' }),
      (error) => error instanceof AppConfigError && /runs as another-app/.test(error.message)
    );
    assert.throws(() => loadAppConfig(write('{ nope')), AppConfigError);
  });

  it('serves its pages and nothing else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body></body></html>');
    const server = http.createServer(async (req, res) => {
      if (!(await serveWebApp(req.method, new URL(req.url ?? '/', 'http://x').pathname, res, { root, appId: 'app-123', config: valid }))) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      assert.strictEqual((await fetch(`${base}/settings/team`)).status, 200);
      assert.strictEqual((await fetch(`${base}/not-a-page`)).status, 404);
      // FlyCommerce takes app-config.json from the portal upload; the app never publishes it.
      assert.strictEqual((await fetch(`${base}/.well-known/flycom-app-config.json`)).status, 404);
    } finally {
      server.close();
    }
  });
});
