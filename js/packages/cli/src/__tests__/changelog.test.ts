import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Commit, analyze, changelogMarkdown, checkTags, nextVersion, tagsFor, titleFor } from '../changelog.js';
import { editorCommand } from '../editor.js';

const commits = (...subjects: (string | [string, string])[]): Commit[] =>
  subjects.map((entry, index) => {
    const [subject, body] = typeof entry === 'string' ? [entry, ''] : entry;
    return { hash: `h${index}`, subject, body };
  });

describe('the next version', () => {
  it('bumps the patch for a fix, the minor for a feat, the major for a breaking change', () => {
    assert.equal(nextVersion('1.2.3', analyze(commits('fix: keep the filter', 'perf: cache it')).bump!), '1.2.4');
    assert.equal(nextVersion('1.2.3', analyze(commits('fix: a', 'feat: b')).bump!), '1.3.0');
    assert.equal(nextVersion('1.2.3', analyze(commits('feat: b', 'refactor!: c')).bump!), '2.0.0');
    assert.equal(nextVersion('1.2.3', analyze(commits(['feat: b', 'Body.\n\nBREAKING CHANGE: the export is CSV only'])).bump!), '2.0.0');
    assert.equal(nextVersion('1.2.3', analyze(commits(['fix: b', 'BREAKING-CHANGE: gone'])).bump!), '2.0.0');
  });

  it('bumps the minor for a breaking change below 1.0.0, and starts at 1.0.0', () => {
    assert.equal(nextVersion('0.4.2', 'major'), '0.5.0');
    assert.equal(nextVersion('0.4.2', 'minor'), '0.5.0');
    assert.equal(nextVersion('0.4.2', 'patch'), '0.4.3');
    assert.equal(nextVersion(undefined, 'patch'), '1.0.0');
  });

  it("doesn't read BREAKING CHANGE mid-line, and counts perf, refactor and reverts as patches", () => {
    assert.equal(analyze(commits(['fix: a', 'Mentions BREAKING CHANGE: in passing'])).bump, 'patch');
    assert.equal(analyze(commits('refactor: a')).bump, 'patch');
    assert.equal(analyze(commits('revert: feat: a')).bump, 'patch');
    assert.equal(analyze(commits('Revert "feat: add CSV export"')).bump, 'patch');
  });

  it('leaves out chores, docs, tests, CI, builds, styles and other commits, unless every commit counts', () => {
    const quiet = commits('chore: deps', 'docs: readme', 'test: more', 'ci: cache', 'build: tsc', 'style: fmt', 'Update index.ts');
    assert.deepEqual(analyze(quiet), { bump: undefined, entries: [], skipped: 7 });

    const all = analyze(quiet, true);
    assert.equal(all.bump, 'patch');
    assert.equal(all.entries.length, 7);
    assert.ok(all.entries.every((entry) => entry.section === 'Other'));
    assert.equal(all.entries[6].description, 'Update index.ts');
  });

  it('counts a breaking chore', () => {
    const analysis = analyze(commits('chore!: drop Node 20'));
    assert.equal(analysis.bump, 'major');
    assert.deepEqual(analysis.entries, [{ section: 'Breaking changes', scope: undefined, description: 'drop Node 20' }]);
  });
});

describe('the changelog', () => {
  const analysis = analyze(
    commits(
      'fix(orders): keep the date filter (#12)',
      'chore: bump deps',
      'feat(export): add CSV export',
      'perf: cache the store settings',
      'feat(api)!: remove the v1 export endpoint',
      'feat: add a dark theme (#15)',
      'docs: explain the export'
    )
  );

  it('groups breaking changes, features, fixes and other, with the scope in bold and PR numbers kept', () => {
    assert.equal(
      changelogMarkdown(analysis.entries),
      [
        '### Breaking changes',
        '',
        '- **api:** remove the v1 export endpoint',
        '',
        '### Features',
        '',
        '- **export:** add CSV export',
        '- add a dark theme (#15)',
        '',
        '### Fixes',
        '',
        '- **orders:** keep the date filter (#12)',
        '',
        '### Other',
        '',
        '- cache the store settings',
      ].join('\n')
    );
    assert.equal(analysis.skipped, 2);
  });

  it('stays within 5000 characters, saying how many changes it left out', () => {
    const many = analyze(commits(...Array.from({ length: 200 }, (_, i) => `fix: correct the rounding of tax line number ${i}`)));
    const text = changelogMarkdown(many.entries);

    assert.ok(text.length <= 5000, String(text.length));
    assert.match(text, /^### Fixes\n\n- correct the rounding of tax line number 0\n/);
    const kept = text.split('\n').filter((line) => line.startsWith('- ')).length;
    assert.match(text, new RegExp(`\\n\\n…and ${200 - kept} more changes\\.$`));
    assert.ok(kept > 50);
  });

  it('takes the title from the first breaking change, else the first feature, else the first fix', () => {
    assert.equal(titleFor(analysis.entries), 'Remove the v1 export endpoint');
    assert.equal(titleFor(analyze(commits('fix: a', 'feat: add CSV export', 'feat: b')).entries), 'Add CSV export');
    assert.equal(titleFor(analyze(commits('perf: p', 'fix: keep the filter')).entries), 'Keep the filter');
    assert.equal(titleFor(analyze(commits('perf: cache it')).entries), 'Cache it');
    assert.equal(titleFor([]), undefined);
  });

  it('keeps the title within 80 characters', () => {
    const title = titleFor(analyze(commits(`feat: ${'x'.repeat(100)}`)).entries)!;
    assert.equal(title.length, 80);
    assert.ok(title.endsWith('…'));
  });

  it('tags the version with up to 5 distinct scopes, as the hub writes tags', () => {
    assert.deepEqual(tagsFor(analysis.entries), ['api', 'export', 'orders']);
    const scoped = analyze(
      commits(
        'fix(Orders): a',
        'feat(app_server): b',
        'fix(orders): c',
        'fix(ui,API): d',
        'fix(dashboard/pages): e',
        'fix(six): f',
        `fix(${'long'.repeat(10)}): g`
      )
    );
    assert.deepEqual(tagsFor(scoped.entries), ['app-server', 'orders', 'ui', 'api', 'dashboard-pages']);
    assert.deepEqual(tagsFor(analyze(commits(`fix(${'long'.repeat(10)}): g`, 'fix(---): h')).entries), ['long'.repeat(7) + 'lo']);
  });
});

describe('--tag', () => {
  it('normalizes as the hub does, and refuses what the hub would', () => {
    assert.deepEqual(checkTags(['  Order   Export ', 'csv', 'CSV', '']), { tags: ['order export', 'csv'], problems: [] });
    assert.deepEqual(checkTags(['a_b']).problems, ['"a_b": tags use letters, numbers, spaces and hyphens.']);
    assert.deepEqual(checkTags(['x'.repeat(31)]).problems, [`"${'x'.repeat(31)}" is longer than 30 characters.`]);
    assert.deepEqual(checkTags(['a', 'b', 'c', 'd', 'e', 'f']).problems, ['Up to 5 tags; 6 were given.']);
  });
});

describe('$EDITOR', () => {
  it('splits into arguments, with quotes grouping and nothing else interpreted', () => {
    assert.deepEqual(editorCommand({ EDITOR: 'code --wait' }), ['code', '--wait']);
    assert.deepEqual(editorCommand({ EDITOR: '"C:\\Program Files\\Editor\\ed.exe" -n', VISUAL: '' }), [
      'C:\\Program Files\\Editor\\ed.exe',
      '-n',
    ]);
    assert.deepEqual(editorCommand({ EDITOR: 'nano', VISUAL: "vim -c 'set tw=72'" }), ['vim', '-c', 'set tw=72']);
    assert.deepEqual(editorCommand({ EDITOR: 'ed; rm -rf ~' }), ['ed;', 'rm', '-rf', '~']);
    assert.equal(editorCommand({}), undefined);
  });
});
