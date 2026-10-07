import { execFileSync } from 'node:child_process';
import { Commit, compareVersions, isVersion } from './changelog.js';
import { childEnv } from './child.js';

export class GitError extends Error {}

export interface Repo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shallow: boolean;
}

function git(repo: Pick<Repo, 'cwd' | 'env'>, args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd: repo.cwd,
      env: childEnv(repo.env),
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const { code, stderr } = error as NodeJS.ErrnoException & { stderr?: string };
    if (code === 'ENOENT') throw new GitError('git is not installed');
    const line = String(stderr ?? '')
      .split('\n')
      .find((text) => text.trim() !== '');
    throw new GitError(line?.replace(/^(fatal|error): /, '').trim() ?? `git ${args[0]} failed`);
  }
}

/** The repository holding cwd, or why there's no history to read. */
export function openRepo(cwd: string, env: NodeJS.ProcessEnv): { repo?: Repo; reason?: string } {
  const at = { cwd, env };

  try {
    git(at, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    return { reason: (error as Error).message };
  }
  try {
    git(at, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return { reason: 'the repository has no commits yet' };
  }

  return { repo: { ...at, shallow: git(at, ['rev-parse', '--is-shallow-repository']).trim() === 'true' } };
}

/** The highest <prefix><x.y.z> tag that HEAD contains. */
export function lastReleaseTag(repo: Repo, prefix: string): { tag: string; version: string } | undefined {
  return git(repo, ['tag', '--merged', 'HEAD', '--list', `${prefix}*`])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith(prefix) && isVersion(tag.slice(prefix.length)))
    .map((tag) => ({ tag, version: tag.slice(prefix.length) }))
    .sort((a, b) => compareVersions(a.version, b.version))
    .at(-1);
}

/** Commits touching cwd, oldest first, since a tag or a date; merges left out. */
export function commitsSince(repo: Repo, since: { tag?: string; date?: string }): Commit[] {
  const range = since.tag ? `refs/tags/${since.tag}..HEAD` : 'HEAD';
  const args = ['log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', range];
  if (since.date) args.push(`--since=${since.date}`);

  return git(repo, [...args, '--', '.'])
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [hash, subject, body = ''] = record.split('\x1f');
      return { hash, subject, body };
    });
}

/** Tracked files under cwd with changes not yet committed. */
export function hasUncommittedChanges(repo: Repo): boolean {
  return git(repo, ['status', '--porcelain', '--untracked-files=no', '--', '.']).trim() !== '';
}

export function createTag(repo: Repo, name: string, message: string): void {
  // verbatim: the default cleanup would drop the changelog's "### " headings as comments.
  git(repo, ['tag', '--annotate', '--cleanup=verbatim', '--file=-', name], message);
}
