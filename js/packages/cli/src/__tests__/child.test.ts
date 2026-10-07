import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { childEnv, isWindowsBatch, quoteWindowsArg, windowsCommandLine } from '../child.js';

describe('the environment of processes the CLI starts', () => {
  it('leaves out the portal token and every other FLYCOMMERCE_ setting', () => {
    const env = childEnv(
      { PATH: '/bin', FLYCOMMERCE_TOKEN: 'secret', flycommerce_portal_url: 'x', FLYCOMMERCE_CLOUDFLARED: 'y' },
      { PORT: '4000' }
    );

    assert.deepEqual(env, { PATH: '/bin', PORT: '4000' });
  });
});

describe('Windows command lines', () => {
  it('quotes each argument for the program, and escapes what cmd.exe would read', () => {
    assert.equal(quoteWindowsArg('dev', false), '^"dev^"');
    assert.equal(quoteWindowsArg('a b', false), '^"a^ b^"');
    assert.equal(quoteWindowsArg('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.equal(quoteWindowsArg('C:\\dir\\', false), '^"C:\\dir\\\\^"');
    assert.equal(quoteWindowsArg('a&b|c>d', false), '^"a^&b^|c^>d^"');
    assert.equal(quoteWindowsArg('%PATH%', false), '^"^%PATH^%^"');
  });

  it('escapes twice for a batch file, which cmd.exe parses again', () => {
    assert.equal(quoteWindowsArg('a&b', true), '^^^"a^^^&b^^^"');
    assert.equal(windowsCommandLine(['npm', 'run', 'dev'], true), 'npm ^^^"run^^^" ^^^"dev^^^"');
    assert.equal(windowsCommandLine(['node', 'server.js'], false), 'node ^"server.js^"');
  });

  it('knows npm is a .cmd shim from PATH and PATHEXT', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'win-path-'));
    fs.writeFileSync(path.join(bin, 'npm.cmd'), '');
    fs.writeFileSync(path.join(bin, 'node.exe'), '');
    const env = { Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    assert.equal(isWindowsBatch('npm', env, os.tmpdir()), true);
    assert.equal(isWindowsBatch('node', env, os.tmpdir()), false);
    assert.equal(isWindowsBatch('run.bat', env, os.tmpdir()), true);
    assert.equal(isWindowsBatch('missing', env, os.tmpdir()), false);
  });
});
