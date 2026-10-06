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

describe('storefront scripts in app-config.json', () => {
  const chat = { handle: 'chat', src: 'https://crm.example.com/widget.js', load: 'interactive' };
  const withScripts = (scripts: unknown) => withChanges({ storefront: { scripts } });
  const problemsWith = (script: Record<string, unknown>) => checkAppConfig(withScripts([{ ...chat, ...script }])).join('\n');

  it('accepts up to three scripts from the app host, with or without load', () => {
    assert.deepStrictEqual(
      checkAppConfig(
        withScripts([
          chat,
          { handle: 'reviews-2', src: 'https://crm.example.com/reviews.js?v=3', load: 'idle' },
          { handle: 'badge', src: 'https://crm.example.com/badge.js' },
        ])
      ),
      []
    );
    assert.deepStrictEqual(checkAppConfig(withScripts([])), []);
    assert.deepStrictEqual(
      checkAppConfig(
        withChanges({
          appUrl: 'http://localhost:4600',
          storefront: { scripts: [{ handle: 'chat', src: 'http://localhost:4600/widget.js' }] },
        })
      ),
      []
    );
  });

  it('refuses a bad handle, a repeated handle, and a bad load', () => {
    assert.match(problemsWith({ handle: 'Chat' }), /handle must be lower-case letters/);
    assert.match(problemsWith({ handle: 'x'.repeat(41) }), /handle must be lower-case letters/);
    assert.match(checkAppConfig(withScripts([chat, { ...chat, src: 'https://crm.example.com/other.js' }])).join(), /repeated: chat/);
    assert.match(problemsWith({ load: 'beforeInteractive' }), /load must be interactive or idle/);
  });

  it('takes scripts only over https, from the app host, up to 2000 characters', () => {
    assert.match(problemsWith({ src: 'http://crm.example.com/widget.js' }), /src must use https/);
    assert.match(problemsWith({ src: 'https://cdn.example.net/widget.js' }), /src must be on crm\.example\.com/);
    assert.match(problemsWith({ src: 'https://example.com/widget.js' }), /src must be on crm\.example\.com/);
    assert.match(problemsWith({ src: '/widget.js' }), /src is not a URL/);
    assert.match(problemsWith({ src: `https://crm.example.com/${'a'.repeat(2000)}.js` }), /up to 2000 characters/);
    assert.match(problemsWith({ src: 'https://user:secret@crm.example.com/widget.js' }), /user name or password/);
    assert.match(problemsWith({ src: 'https://user@crm.example.com/widget.js' }), /user name or password/);
    assert.match(problemsWith({ src: 'https://crm.example.com/widget.js#v2' }), /must not have a #/);
    assert.match(problemsWith({ src: 'https://crm.example.com/widget.js#' }), /must not have a #/);
    assert.match(problemsWith({ src: 'https://crm.example.com\\@evil.example/widget.js' }), /must not contain \\\./);
    assert.match(problemsWith({ src: 'https://crm.example.com/js\\widget.js' }), /must not contain \\\./);
  });

  it('allows three scripts at most, and no keys it does not know', () => {
    const four = ['a', 'b', 'c', 'd'].map((handle) => ({ handle, src: `https://crm.example.com/${handle}.js` }));

    assert.match(checkAppConfig(withScripts(four)).join(), /list of up to 3 scripts/);
    assert.match(checkAppConfig(withScripts({ chat })).join(), /list of up to 3 scripts/);
    assert.match(problemsWith({ placement: 'head' }), /scripts\[0\] does not take placement/);
    assert.match(
      checkAppConfig(withChanges({ storefront: { scripts: [chat], widget: {} } })).join(),
      /storefront takes only scripts; it does not take widget/
    );
    assert.match(checkAppConfig(withChanges({ storefront: 'chat.js' })).join(), /storefront must be an object/);
    assert.match(checkAppConfig(withChanges({ storefront: {} })).join(), /storefront\.scripts must be a list/);
  });
});
