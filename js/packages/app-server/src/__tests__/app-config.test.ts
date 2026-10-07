import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, AppConfigError, checkAppConfig, loadAppConfig, pagePaths, resolveAppConfig } from '../app-config.js';
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
    assert.match(problemsWith({ src: 'widget.js' }), /src is not a URL or a path starting with \//);
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

describe('paths and the install redirect in app-config.json', () => {
  const welcome = { handle: 'welcome', src: '/storefront/welcome.js' };

  it('takes a script src and the install redirect as paths on appUrl, and versionId and version as optional', () => {
    const { versionId, version, ...unversioned } = valid;
    const config = { ...unversioned, install: { redirectUrl: '/auth/callback' }, storefront: { scripts: [welcome] } };

    assert.deepStrictEqual(checkAppConfig(config), []);
    assert.deepStrictEqual(checkAppConfig(withChanges({ install: { redirectUrl: 'https://crm.example.com/auth/callback' } })), []);
    assert.deepStrictEqual(checkAppConfig(withChanges({ install: {} })), []);
  });

  it('refuses a path that could name another host, and a redirect on another host', () => {
    const scriptProblems = (src: string) => checkAppConfig(withChanges({ storefront: { scripts: [{ ...welcome, src }] } })).join('\n');
    const redirectProblems = (redirectUrl: unknown) => checkAppConfig(withChanges({ install: { redirectUrl } })).join('\n');

    assert.match(scriptProblems('//evil.example/welcome.js'), /src must be a path starting with a single \//);
    assert.match(scriptProblems('/\\evil.example/welcome.js'), /src must not contain \\/);
    assert.match(scriptProblems('/welcome.js#v2'), /src must not have a #/);
    assert.match(scriptProblems('/my welcome.js'), /src must not contain spaces/);
    assert.match(redirectProblems('//evil.example/auth/callback'), /install\.redirectUrl must be a path starting with a single \//);
    assert.match(redirectProblems('https://evil.example/auth/callback'), /install\.redirectUrl must be on crm\.example\.com/);
    assert.match(redirectProblems('http://crm.example.com/auth/callback'), /install\.redirectUrl must use https/);
    assert.match(redirectProblems('/auth/callback#x'), /install\.redirectUrl must not have a #/);
    assert.match(redirectProblems(''), /install\.redirectUrl must be a path or a URL/);
    assert.match(
      checkAppConfig(withChanges({ install: { redirectUrl: '/a', scopes: [] } })).join(),
      /install takes only redirectUrl; it does not take scopes/
    );
    assert.match(checkAppConfig(withChanges({ install: '/auth/callback' })).join(), /install must be an object/);
  });

  it('keeps the joined install redirect within 255 characters and its host in ASCII, as FlyCommerce does', () => {
    const redirect = (appUrl: string, redirectUrl: string) => checkAppConfig(withChanges({ appUrl, install: { redirectUrl } })).join('\n');
    const base = 'https://crm.example.com';

    assert.equal(redirect(base, `/${'a'.repeat(255 - base.length - 1)}`), '');
    assert.match(redirect(base, `/${'a'.repeat(256 - base.length - 1)}`), /at most 255 characters once joined to appUrl/);
    assert.match(redirect('https://bücher.example', '/auth/callback'), /ASCII host; write an international domain in its xn-- form/);
    assert.match(redirect('https://bücher.example', 'https://bücher.example/auth/callback'), /ASCII host/);
    assert.equal(redirect('https://xn--bcher-kva.example', '/auth/callback'), '');
  });

  it('keeps the install redirect exactly as written, since it is compared byte for byte', () => {
    const resolved = resolveAppConfig({ ...valid, appUrl: 'https://Dev.Example.com', install: { redirectUrl: '/Auth/Callback' } });

    assert.equal(resolved.install?.redirectUrl, 'https://Dev.Example.com/Auth/Callback');
  });

  it('still checks versionId and version when they are there', () => {
    const problems = checkAppConfig(withChanges({ versionId: 0, version: '1.2' })).join('\n');

    assert.match(problems, /versionId must be a whole number/);
    assert.match(problems, /version must be three numbers/);
  });

  it('resolves paths against appUrl, or against the appUrl it is given, and keeps absolute URLs', () => {
    const config: AppConfig = {
      ...valid,
      appUrl: 'https://crm.example.com/',
      install: { redirectUrl: '/auth/callback' },
      storefront: { scripts: [welcome, { handle: 'chat', src: 'https://crm.example.com/chat.js', load: 'idle' }] },
    };

    const resolved = resolveAppConfig(config);
    assert.strictEqual(resolved.install?.redirectUrl, 'https://crm.example.com/auth/callback');
    assert.deepStrictEqual(
      resolved.storefront?.scripts.map((script) => script.src),
      ['https://crm.example.com/storefront/welcome.js', 'https://crm.example.com/chat.js']
    );
    assert.deepStrictEqual(resolved.dashboard, config.dashboard);

    const tunnel = resolveAppConfig(config, { appUrl: 'https://quiet-fox.trycloudflare.com' });
    assert.strictEqual(tunnel.appUrl, 'https://quiet-fox.trycloudflare.com');
    assert.strictEqual(tunnel.install?.redirectUrl, 'https://quiet-fox.trycloudflare.com/auth/callback');
    assert.strictEqual(tunnel.storefront?.scripts[0].src, 'https://quiet-fox.trycloudflare.com/storefront/welcome.js');
    assert.strictEqual(config.storefront?.scripts[0].src, '/storefront/welcome.js', 'the input is left as it was');
  });
});
