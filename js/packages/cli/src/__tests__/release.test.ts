import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakePortal, runCli } from './fake-portal.js';

const config = {
  appId: 'order-export',
  appUrl: 'https://export.example.com',
  install: { redirectUrl: '/auth/callback' },
  dashboard: { pages: [{ slug: 'export', label: 'Export orders', path: '/export' }] },
};

describe('flycommerce app release, from the commits', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let clock: number;

  const git = (args: string[], cwd = dir, extra: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' }).trim();

  /** A commit touching file, dated a day after the last one unless a date is given. */
  const commit = (message: string, { file = 'src.txt', date }: { file?: string; date?: string } = {}) => {
    const at = date ?? new Date((clock += 86400_000)).toISOString();
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.appendFileSync(path.join(dir, file), `${message}\n`);
    git(['add', '--', file]);
    git(['commit', '--quiet', '--message', message], dir, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  };
  const tag = (name: string) => git(['tag', '--annotate', '--message', name, name]);
  const tags = () => git(['tag', '--list']).split('\n').filter(Boolean);
  const posts = () => portal.apiCalls().filter((call) => call.method === 'POST');
  const cli = (argv: string[], prompt?: (question: string) => Promise<string>) =>
    runCli([...argv, '--portal', portal.url], { env, cwd: dir, prompt });

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-release-'));
    clock = Date.parse('2026-01-01T00:00:00Z');
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      FLYCOMMERCE_TOKEN: portal.token,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Dev Person',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev Person',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    };
    portal.apps.clear();
    portal.requests.length = 0;
    portal.releaseAnswer = undefined;
    portal.addApp({ appId: 'order-export', name: 'Order Export', published: true, status: 'published' });

    git(['init', '--quiet', '--initial-branch=main']);
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(config));
    git(['add', 'app-config.json']);
    commit('chore: start');
  });

  it('works out the next version from the tag, releases it, and tags the commit with the changelog', async () => {
    portal.apps.get('order-export')!.versions.push({ versionId: 1, version: '1.2.0', title: '1.2.0', releasedAt: '2026-01-01T12:00:00Z' });
    tag('app-v1.2.0');
    commit('fix(orders): keep the date filter (#12)');
    commit('docs: explain the export');
    commit('feat(export): add CSV export');

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      posts().map((call) => call.path),
      ['/api/cli/v1/apps/order-export/versions', '/api/cli/v1/apps/order-export/versions/2/release']
    );
    const changelog = '### Features\n\n- **export:** add CSV export\n\n### Fixes\n\n- **orders:** keep the date filter (#12)';
    assert.deepEqual(posts()[0].body, { version: '1.3.0', title: 'Add CSV export', changelog, tags: ['export', 'orders'] });
    assert.equal(posts()[1].body.config.version, '1.3.0');
    assert.match(result.stdout, /Version {4}1\.2\.0 → 1\.3\.0 \(minor: since app-v1\.2\.0\)/);
    assert.match(result.stdout, /Tagged app-v1\.3\.0; the next release starts from it\. Share it with: git push origin app-v1\.3\.0/);

    assert.deepEqual(tags(), ['app-v1.2.0', 'app-v1.3.0']);
    assert.equal(git(['cat-file', '-t', 'app-v1.3.0']), 'tag');
    assert.equal(git(['rev-parse', 'app-v1.3.0^{commit}']), git(['rev-parse', 'HEAD']));
    assert.equal(git(['tag', '--list', '--format=%(contents)', 'app-v1.3.0']), `Add CSV export\n\n${changelog}`);
  });

  it('starts from the highest release tag in HEAD, and only its own prefix', async () => {
    tag('app-v1.2.0');
    tag('app-v1.10.0');
    tag('v7.0.0');
    tag('app-dev-v9.0.0');
    git(['checkout', '--quiet', '-b', 'side']);
    commit('feat: elsewhere');
    tag('app-v5.0.0');
    git(['checkout', '--quiet', 'main']);
    commit('fix: keep the filter');

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(posts()[0].body.version, '1.10.1');
    assert.equal(posts()[0].body.changelog, '### Fixes\n\n- keep the filter');
  });

  it('bumps the minor number for a breaking change below 1.0.0', async () => {
    tag('app-v0.4.2');
    commit('feat(api)!: drop the v1 export');

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(posts()[0].body.version, '0.5.0');
    assert.match(posts()[0].body.changelog, /^### Breaking changes\n\n- \*\*api:\*\* drop the v1 export$/);
  });

  it('uses app-<name>-v tags for --config <name>, or --tag-prefix', async () => {
    fs.writeFileSync(path.join(dir, 'app-config.dev.json'), JSON.stringify(config));
    tag('app-v3.0.0');
    tag('app-dev-v0.2.0');
    tag('v2.0.0');
    commit('feat: add CSV export');

    const dev = await cli(['app', 'release', '--config', 'dev', '--yes', '--no-git-tag']);
    assert.equal(dev.code, 0, dev.stderr);
    assert.equal(posts()[0].body.version, '0.3.0');

    const prefixed = await cli(['app', 'release', '--tag-prefix', 'v', '--dry-run']);
    assert.equal(prefixed.code, 0, prefixed.stderr);
    assert.match(prefixed.stdout, /2\.0\.0 → 2\.1\.0/);

    const bad = await cli(['app', 'release', '--tag-prefix', 'app-*', '--dry-run']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--tag-prefix takes letters/);
  });

  it('without a tag, starts from the version released last and the commits since its date', async () => {
    commit('feat: before the release', { date: '2026-02-01T00:00:00Z' });
    commit('fix: after the release', { date: '2026-03-01T00:00:00Z' });
    portal.apps
      .get('order-export')!
      .versions.push(
        { versionId: 1, version: '1.3.0', title: '1.3.0', releasedAt: '2026-01-15T00:00:00Z' },
        { versionId: 2, version: '1.4.0', title: '1.4.0', releasedAt: '2026-02-15T00:00:00Z' }
      );

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(posts()[0].body.version, '1.4.1');
    assert.equal(posts()[0].body.changelog, '### Fixes\n\n- after the release');
    assert.match(result.stdout, /since 1\.4\.0 was released on 2026-02-15 \(no app-v<x\.y\.z> tag\)/);
    assert.deepEqual(tags(), ['app-v1.4.1']);
  });

  it('starts from a release newer than the tag, made without tagging, by its date', async () => {
    tag('app-v1.2.0');
    commit('feat: released in CI', { date: '2026-01-10T00:00:00Z' });
    commit('fix: keep the filter', { date: '2026-01-20T00:00:00Z' });
    portal.apps
      .get('order-export')!
      .versions.push(
        { versionId: 1, version: '1.2.0', title: '1.2.0', releasedAt: '2026-01-02T00:00:00Z' },
        { versionId: 2, version: '1.3.0', title: '1.3.0', releasedAt: '2026-01-15T00:00:00Z' }
      );

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(posts()[0].body.version, '1.3.1');
    assert.equal(posts()[0].body.changelog, '### Fixes\n\n- keep the filter');
    assert.match(
      result.stdout,
      /1\.3\.0 → 1\.3\.1 \(patch: since 1\.3\.0 was released on 2026-01-15 \(newer than the tag app-v1\.2\.0\)\)/
    );
  });

  it('starts at 1.0.0 when nothing is released, from the whole history', async () => {
    commit('feat: export orders');

    const result = await cli(['app', 'release', '--dry-run']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /none → 1\.0\.0 \(minor: in the whole history \(nothing released yet\)\)/);
  });

  it('stops, exiting 0, when there is nothing releasable, unless every commit counts or the version is given', async () => {
    tag('app-v1.2.0');
    commit('chore: bump deps');
    commit('docs: explain the export');

    const nothing = await cli(['app', 'release', '--yes']);
    assert.equal(nothing.code, 0, nothing.stderr);
    assert.match(
      nothing.stdout,
      /Nothing to release: no feat, fix, perf, refactor or revert commits since app-v1\.2\.0 \(2 others left out\)/
    );
    assert.match(nothing.stdout, /\n {2}- Count every commit with --include-all\./);
    assert.deepEqual(posts(), []);

    const all = await cli(['app', 'release', '--include-all', '--dry-run']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /1\.2\.0 → 1\.2\.1/);
    assert.match(all.stdout, /### Other\n\n {2}- bump deps\n {2}- explain the export/);

    const given = await cli(['app', 'release', '--version', '1.2.1', '--yes']);
    assert.equal(given.code, 1);
    assert.match(given.stderr, /--message is required: there are no commits since app-v1\.2\.0 to write the changelog from/);

    const both = await cli(['app', 'release', '--version', '1.2.1', '--message', 'Dependency updates', '--yes']);
    assert.equal(both.code, 0, both.stderr);
    assert.equal(posts()[0].body.changelog, 'Dependency updates');
  });

  it('only previews with --dry-run: no version, no release, no tag', async () => {
    tag('app-v1.2.0');
    commit('feat(export): add CSV export');

    const result = await cli(['app', 'release', '--dry-run']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Title {6}Add CSV export\n {2}Tags {7}export\n {2}Git tag {4}app-v1\.3\.0\n\n {2}### Features\n\n {2}- \*\*export:\*\* add CSV export/
    );
    assert.match(result.stdout, /Dry run: nothing was created, released or tagged\./);
    assert.deepEqual(posts(), []);
    assert.deepEqual(tags(), ['app-v1.2.0']);
  });

  it('asks at a terminal, and without one needs --yes when it worked anything out', async () => {
    tag('app-v1.2.0');
    commit('feat: add CSV export');

    const unattended = await cli(['app', 'release']);
    assert.equal(unattended.code, 1);
    assert.match(unattended.stderr, /pass --yes to release, or --dry-run to only preview/);

    const questions: string[] = [];
    const declined = await cli(['app', 'release'], async (question) => (questions.push(question), 'n'));
    assert.equal(declined.code, 1);
    assert.match(declined.stderr, /Cancelled; nothing was released/);
    assert.deepEqual(questions, ['Release 1.3.0 of Order Export? (y/N) ']);
    assert.deepEqual(posts(), []);
    assert.deepEqual(tags(), ['app-v1.2.0']);

    const agreed = await cli(['app', 'release'], async () => 'y');
    assert.equal(agreed.code, 0, agreed.stderr);
    assert.equal(posts().length, 2);
    assert.deepEqual(tags(), ['app-v1.2.0', 'app-v1.3.0']);
  });

  it("doesn't tag with --no-git-tag or --no-release", async () => {
    tag('app-v1.2.0');
    commit('feat: add CSV export');

    const created = await cli(['app', 'release', '--yes', '--no-release']);
    assert.equal(created.code, 0, created.stderr);
    assert.doesNotMatch(created.stdout, /Git tag/);
    assert.deepEqual(tags(), ['app-v1.2.0']);

    const released = await cli(['app', 'release', '--yes', '--no-git-tag']);
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stdout, /Released 1\.3\.0/);
    assert.deepEqual(tags(), ['app-v1.2.0']);
  });

  it('warns about uncommitted changes, and that a tag it could not create is still to make', async () => {
    tag('app-v1.2.0');
    commit('feat: add CSV export');
    git(['checkout', '--quiet', '-b', 'side', 'HEAD~1']);
    commit('feat: elsewhere');
    tag('app-v1.3.0');
    git(['checkout', '--quiet', 'main']);
    fs.appendFileSync(path.join(dir, 'src.txt'), 'work in progress\n');

    const result = await cli(['app', 'release', '--yes']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Warning: there are uncommitted changes here/);
    assert.match(result.stdout, /Released 1\.3\.0/);
    assert.match(result.stderr, /Warning: released, but the git tag app-v1\.3\.0 wasn't created: tag 'app-v1\.3\.0' already exists/);
  });

  it('takes --message, --title and --tag over what it would write', async () => {
    tag('app-v1.2.0');
    commit('feat(export): add CSV export');

    const result = await cli([
      'app',
      'release',
      '--yes',
      '--message',
      'CSV export, at last.',
      '--title',
      'CSV export',
      '--tag',
      'Order Export',
      '--tag',
      'csv',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(posts()[0].body, {
      version: '1.3.0',
      title: 'CSV export',
      changelog: 'CSV export, at last.',
      tags: ['order export', 'csv'],
    });
  });

  it('refuses tags, titles and versions the hub would refuse, before calling it', async () => {
    tag('app-v1.2.0');
    commit('feat: add CSV export');
    portal.apps.get('order-export')!.versions.push({ versionId: 1, version: '1.2.0', title: '1.2.0', releasedAt: '2026-01-01T12:00:00Z' });

    const tagged = await cli(['app', 'release', '--tag', 'a_b', '--tag', 'b', '--tag', 'c', '--tag', 'd', '--tag', 'e', '--tag', 'f']);
    assert.equal(tagged.code, 1);
    assert.match(
      tagged.stderr,
      /--tag is not valid:\n {2}- "a_b": tags use letters, numbers, spaces and hyphens\.\n {2}- Up to 5 tags; 6 were given\./
    );

    const titled = await cli(['app', 'release', '--title', 'x'.repeat(81)]);
    assert.match(titled.stderr, /--title must be 1 to 80 characters/);
    assert.deepEqual(portal.apiCalls(), []);

    const lower = await cli(['app', 'release', '--version', '1.1.0', '--message', 'x']);
    assert.equal(lower.code, 1);
    assert.match(lower.stderr, /1\.1\.0 is lower than 1\.2\.0, the last released version of Order Export/);
    assert.deepEqual(posts(), []);
  });

  it('opens $EDITOR on the changelog, in a file only this user can read', async () => {
    tag('app-v1.2.0');
    commit('feat: add CSV export');
    const editor = path.join(dir, 'editor.cjs');
    const seen = path.join(dir, 'seen.json');
    fs.writeFileSync(
      editor,
      `const fs = require('fs'); const file = process.argv[2];
       fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777, token: process.env.FLYCOMMERCE_TOKEN ?? null }));
       fs.writeFileSync(file, '- CSV export, rewritten by hand\\n');`
    );
    env.EDITOR = `${process.execPath} ${editor}`;

    const result = await cli(['app', 'release', '--edit'], async () => 'y');

    assert.equal(result.code, 0, result.stderr);
    const opened = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(opened.text, '### Features\n\n- add CSV export\n');
    if (process.platform !== 'win32') assert.equal(opened.mode, 0o600);
    assert.equal(opened.token, null);
    assert.equal(posts()[0].body.changelog, '- CSV export, rewritten by hand');
    assert.match(result.stdout, /\n {2}- CSV export, rewritten by hand\n/);
  });

  it('needs --version outside a git repository', async () => {
    fs.rmSync(path.join(dir, '.git'), { recursive: true });
    const outside = { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };

    const result = await runCli(['app', 'release', '--yes', '--portal', portal.url], { env: outside, cwd: dir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /There's no git history here to work out the version from: not a git repository/);
    assert.match(result.stderr, /--version <x\.y\.z> --message/);
    assert.deepEqual(portal.apiCalls(), []);

    const given = await runCli(['app', 'release', '--version', '1.0.0', '--message', 'First', '--portal', portal.url], {
      env: outside,
      cwd: dir,
    });
    assert.equal(given.code, 0, given.stderr);
    assert.equal(posts()[0].body.version, '1.0.0');
    assert.doesNotMatch(given.stdout, /Tagged/);
  });

  it('counts only the commits that touch the app directory', async () => {
    fs.mkdirSync(path.join(dir, 'apps', 'export'), { recursive: true });
    fs.renameSync(path.join(dir, 'app-config.json'), path.join(dir, 'apps', 'export', 'app-config.json'));
    commit('chore: move the app', { file: 'apps/export/notes.txt' });
    git(['add', '--all']);
    git(['commit', '--quiet', '--message', 'chore: move config'], dir, { GIT_COMMITTER_DATE: '2026-01-10T00:00:00Z' });
    tag('app-v1.0.0');
    commit('feat: another app', { file: 'apps/other/a.txt' });
    commit('fix: the export', { file: 'apps/export/b.txt' });

    const result = await runCli(['app', 'release', '--dry-run', '--portal', portal.url], { env, cwd: path.join(dir, 'apps', 'export') });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /1\.0\.0 → 1\.0\.1/);
    assert.match(result.stdout, /- the export/);
    assert.doesNotMatch(result.stdout, /another app/);
  });

  it('describes the new options in its help', async () => {
    const help = await cli(['app', 'release', '--help']);

    assert.equal(help.code, 0);
    for (const option of [
      '--dry-run',
      '--edit',
      '--yes',
      '--tag <tag>',
      '--tag-prefix',
      '--include-all',
      '--no-git-tag',
      'BREAKING CHANGE',
    ]) {
      assert.ok(help.stdout.includes(option), option);
    }
  });
});
