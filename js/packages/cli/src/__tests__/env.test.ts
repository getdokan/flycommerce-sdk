import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { parseEnv, writeEnvValues } from '../env.js';
import { FakePortal, runCli } from './fake-portal.js';

describe('flycommerce env pull', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const cli = (...argv: string[]) => runCli([...argv, '--portal', portal.url], { env, cwd: dir });
  const read = (file = '.env') => fs.readFileSync(path.join(dir, file), 'utf8');

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-env-'));
    env = { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: portal.token };
  });

  it("writes the portal's platform to a new .env readable only by you", async () => {
    const result = await cli('env', 'pull');

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      read(),
      [
        '# The platform behind https://developers.example.test, from flycommerce env pull',
        'HUB_API_URL=https://developers.example.test/api',
        'JWKS_URL=https://hub.example.test/.well-known/jwks.json',
        'ALLOWED_ISSUERS=https://hub.example.test',
        "FRAME_ANCESTORS='https://*.example.shop https://*.example.test'",
        '',
      ].join('\n')
    );
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    assert.match(result.stdout, /Created \.env for https:\/\/developers\.example\.test/);
  });

  it('replaces only its own keys, keeping comments, secrets and order, and drops a key set twice', async () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        '# my app',
        'APP_ID=order-export',
        'HUB_API_URL=https://developers.flycommerce.com/api',
        'APP_SECRET=s3cret',
        'HUB_API_URL=stale',
        '',
      ].join('\n')
    );

    assert.equal((await cli('env', 'pull')).code, 0);

    assert.equal(
      read(),
      [
        '# my app',
        'APP_ID=order-export',
        'HUB_API_URL=https://developers.example.test/api',
        'APP_SECRET=s3cret',
        '',
        '# The platform behind https://developers.example.test, from flycommerce env pull',
        'JWKS_URL=https://hub.example.test/.well-known/jwks.json',
        'ALLOWED_ISSUERS=https://hub.example.test',
        "FRAME_ANCESTORS='https://*.example.shop https://*.example.test'",
        '',
      ].join('\n')
    );
  });

  it('writes another file with --file, and joins several issuers with commas', async () => {
    portal.environment = { ...portal.environment, allowedIssuers: ['https://a.example', 'https://b.example'] };

    assert.equal((await cli('env', 'pull', '--file', '.env.staging')).code, 0);

    assert.match(read('.env.staging'), /^ALLOWED_ISSUERS=https:\/\/a\.example,https:\/\/b\.example$/m);
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
    portal.environment = { ...portal.environment, allowedIssuers: ['https://hub.example.test'] };
  });

  it("refuses what the portal sends when it isn't a plain http(s) URL, and writes nothing", async () => {
    const good = portal.environment;
    for (const bad of [
      { ...good, hubApiUrl: 'https://x.test/api\nAPP_SECRET=stolen' },
      { ...good, jwksUrl: 'file:///etc/passwd' },
      { ...good, allowedIssuers: [] },
      { ...good, frameAncestors: 'https://*.ok.test "quoted"' },
    ]) {
      portal.environment = bad;
      const result = await cli('env', 'pull');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /isn't a list of http\(s\) URLs, so nothing was written/);
    }
    portal.environment = good;
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
  });

  it('needs a sign-in', async () => {
    env = { XDG_CONFIG_HOME: dir };
    assert.match((await cli('env', 'pull')).stderr, /not signed in/);
  });
});

describe('parseEnv', () => {
  it('reads what dotenv files hold: quotes, export, inline comments and blank lines', () => {
    assert.deepEqual(
      parseEnv(['# comment', '', 'export A=1', 'B="two words"', "C='x # y'", 'D=plain # note', 'not a line', '#E=commented'].join('\n')),
      { A: '1', B: 'two words', C: 'x # y', D: 'plain' }
    );
  });
});

describe('writeEnvValues', () => {
  it('refuses a value with a line break or another control character, leaving the file as it was', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-envfile-')), '.env');
    fs.writeFileSync(file, 'KEEP=1\n');

    assert.throws(() => writeEnvValues(file, { APP_SECRET: 'abc\nEVIL=1' }, 'x'), /line break or another control character/);
    assert.throws(() => writeEnvValues(file, { APP_SECRET: 'abc\u0000' }, 'x'), /control character/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP=1\n');
  });
});

describe('writeEnvValues keeps the file as it was written', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-envkeep-')), '.env');

  it("keeps lines whose keys are an object's own names, export prefixes and CRLF line endings", () => {
    const at = file();
    fs.writeFileSync(at, 'constructor=keepme\r\ntoString=x\r\nexport APP_SECRET=old\r\n');

    writeEnvValues(at, { APP_SECRET: 'new' }, 'x');

    assert.equal(fs.readFileSync(at, 'utf8'), 'constructor=keepme\r\ntoString=x\r\nexport APP_SECRET=new\r\n');
  });

  it("quotes a value so Node's own loader reads it back as written, and refuses one it can't keep", () => {
    const at = file();
    const values = { SPACED: 'a b', QUOTED: `it's "fine"`.replace('"fine"', 'fine'), BACKSLASH: 'a\\b c' };

    writeEnvValues(at, values, 'x');
    const loaded: Record<string, string | undefined> = {};
    const before = { ...process.env };
    process.loadEnvFile(at);
    for (const key of Object.keys(values)) loaded[key] = process.env[key];
    for (const key of Object.keys(values)) if (!(key in before)) delete process.env[key];

    assert.deepEqual(loaded, values);
    assert.throws(() => writeEnvValues(at, { BOTH: `'a' "b"` }, 'x'), /both kinds of quote/);
  });
});
