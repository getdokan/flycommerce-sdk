import { checkAppConfig } from '@flycommerce/app-server';
import { liveVersion } from './apps.js';
import {
  Analysis,
  LIMITS,
  analyze,
  changelogMarkdown,
  checkTags,
  compareVersions,
  highestVersion,
  isVersion,
  nextVersion,
  tagsFor,
  titleFor,
} from './changelog.js';
import { readConfigFile } from './config-file.js';
import { CliError, Context, confirmed } from './context.js';
import { editText } from './editor.js';
import { Repo, commitsSince, createTag, hasUncommittedChanges, lastReleaseTag, openRepo } from './git.js';
import { ApiError, PortalApi } from './portal.js';
import { AppDetails, ReleaseResult } from './types.js';

// awaitingReview names the redirect this way, beside page slugs and script handles.
const REDIRECT_REVIEW_KEY = 'install.redirectUrl';
// Glob characters would widen the tag search, and a leading "-" would read as an option.
const TAG_PREFIX = /^(?:[A-Za-z0-9_][A-Za-z0-9._/-]*)?$/;

export interface ReleaseOptions {
  config?: string;
  version?: string;
  message?: string;
  title?: string;
  tags?: string[];
  tagPrefix?: string;
  includeAll?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  edit?: boolean;
  noRelease?: boolean;
  noGitTag?: boolean;
}

/** app-v for app-config.json, app-<name>-v for app-config.<name>.json. */
export function defaultTagPrefix(config: string | undefined): string {
  return config === undefined ? 'app-v' : `app-${config}-v`;
}

interface History {
  /** Where the commits start, for the preview. */
  since: string;
  analysis: Analysis;
  /** The version the next one follows: the higher of the last tag and the last released version. */
  previous?: string;
}

function checkOptions(options: ReleaseOptions): void {
  if (options.version !== undefined && !isVersion(options.version)) {
    throw new CliError('--version must be three numbers, like 1.2.0.');
  }
  if (options.message !== undefined && options.message.trim() === '') {
    throw new CliError('--message is empty: write what changed in this version, or leave it out to write it from the commits.');
  }
  if (options.title !== undefined && (options.title.trim() === '' || options.title.trim().length > LIMITS.title)) {
    throw new CliError(`--title must be 1 to ${LIMITS.title} characters.`);
  }
  if (options.tagPrefix !== undefined && (!TAG_PREFIX.test(options.tagPrefix) || options.tagPrefix.includes('..'))) {
    throw new CliError(`--tag-prefix takes letters, numbers, ".", "_", "/" and "-", like app-v; "${options.tagPrefix}" isn't one.`);
  }
}

export async function release(ctx: Context, portal: string, options: ReleaseOptions): Promise<void> {
  checkOptions(options);

  const tagCheck = options.tags && options.tags.length > 0 ? checkTags(options.tags) : undefined;
  if (tagCheck && tagCheck.problems.length > 0) throw new CliError('--tag is not valid:', tagCheck.problems);
  if (options.edit && !ctx.prompt) throw new CliError('--edit needs a terminal to open the editor in.');

  const file = readConfigFile(ctx, options.config);
  // The CLI fills these in, so whatever the file says is replaced.
  const { versionId: _versionId, version: _version, ...config } = file.config;
  const problems = checkAppConfig(config);

  if (problems.length > 0) {
    throw new CliError(`${file.name} is not valid:`, problems);
  }

  const prefix = options.tagPrefix ?? defaultTagPrefix(options.config);
  const { repo, reason } = openRepo(ctx.cwd, ctx.env);

  if (!repo && options.version === undefined) {
    throw new CliError(`There's no git history here to work out the version from: ${reason}.`, [
      'Pass the version and changelog: flycommerce app release --version <x.y.z> --message "…"',
    ]);
  }

  const api = PortalApi.signedIn(portal, ctx);
  const appPath = `apps/${encodeURIComponent(file.appId)}`;
  const app = await api.get<AppDetails>(appPath);
  const released = app.versions.filter((candidate) => candidate.releasedAt);
  const lastReleased = highestVersion(released.map((candidate) => candidate.version));

  if (options.version !== undefined) {
    if (released.some((candidate) => candidate.version === options.version)) {
      throw new CliError(`${options.version} of ${app.name} is already released. Release a new version number.`);
    }
    if (lastReleased !== undefined && compareVersions(options.version, lastReleased) < 0) {
      throw new CliError(`${options.version} is lower than ${lastReleased}, the last released version of ${app.name}.`);
    }
  }

  const history = readHistory(ctx, repo, prefix, app, lastReleased, options.includeAll === true);
  const bump = history.analysis.bump;
  const version = options.version ?? (bump && nextVersion(history.previous, bump));

  if (version === undefined) {
    ctx.stdout(nothingToRelease(history));
    return;
  }

  let changelog =
    options.message?.trim() ?? (history.analysis.entries.length > 0 ? changelogMarkdown(history.analysis.entries) : undefined);

  if (changelog === undefined && !options.edit) {
    throw new CliError(
      repo
        ? `--message is required: there are no commits ${history.since} to write the changelog from.`
        : '--message is required: what changed in this version, for the changelog.'
    );
  }
  if (options.edit) {
    changelog = await editText(ctx, changelog ?? '', 'CHANGELOG.md');
  }
  if (!changelog) throw new CliError('The changelog is empty; nothing was released.');
  if (changelog.length > LIMITS.changelog) {
    throw new CliError(`The changelog is ${changelog.length} characters; FlyCommerce takes up to ${LIMITS.changelog}.`);
  }

  const title = options.title?.trim() || titleFor(history.analysis.entries) || version;
  const tags = tagCheck?.tags ?? tagsFor(history.analysis.entries);
  const tagName = `${prefix}${version}`;
  const tagging = repo !== undefined && !options.noGitTag && !options.noRelease;

  const source = options.version !== undefined ? '--version' : `${bump}: ${history.since}`;
  ctx.stdout(
    [
      `${app.name} (${app.appId})`,
      `  Version    ${history.previous ?? 'none'} → ${version} (${source})`,
      `  Title      ${title}`,
      `  Tags       ${tags.length > 0 ? tags.join(', ') : '(none)'}`,
      ...(tagging ? [`  Git tag    ${tagName}`] : []),
      '',
      ...changelog.split('\n').map((line) => (line === '' ? '' : `  ${line}`)),
      '',
    ].join('\n')
  );

  if (repo && hasUncommittedChanges(repo)) {
    ctx.stderr('Warning: there are uncommitted changes here; the changelog and the git tag cover committed work only.');
  }

  if (options.dryRun) {
    ctx.stdout('Dry run: nothing was created, released or tagged.');
    return;
  }

  await confirm(ctx, options, `${options.noRelease ? 'Create' : 'Release'} ${version} of ${app.name}? (y/N) `);

  const versionId = await createVersion(ctx, api, appPath, app, { version, changelog, title, tags });

  if (options.noRelease) {
    ctx.stdout('Not released (--no-release). Run the same command without --no-release to release it.');
    return;
  }

  let result: ReleaseResult;

  try {
    result = await api.post<ReleaseResult>(`${appPath}/versions/${versionId}/release`, {
      config: { ...config, versionId, version },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'invalid_config') {
      throw new ApiError(
        error.status,
        error.code,
        `${error.message}\nVersion ${version} (#${versionId}) exists but isn't released. Fix ${file.name} and run the same command again.`,
        error.problems
      );
    }
    throw error;
  }

  ctx.stdout(`Released ${result.version} (#${result.versionId}) of ${app.name}.`);
  reportReview(ctx, app, result);

  if (tagging && repo) {
    try {
      createTag(repo, tagName, `${title}\n\n${changelog}\n`);
      ctx.stdout(`Tagged ${tagName}; the next release starts from it. Share it with: git push origin ${tagName}`);
    } catch (error) {
      ctx.stderr(`Warning: released, but the git tag ${tagName} wasn't created: ${(error as Error).message}`);
    }
  }
}

function readHistory(
  ctx: Context,
  repo: Repo | undefined,
  prefix: string,
  app: AppDetails,
  lastReleased: string | undefined,
  includeAll: boolean
): History {
  if (!repo) return { since: 'without git history', analysis: analyze([]), previous: lastReleased };

  if (repo.shallow) {
    ctx.stderr('Warning: this is a shallow clone, so older commits and tags are missing. In CI, fetch the full history (fetch-depth: 0).');
  }

  const tag = lastReleaseTag(repo, prefix);
  const previous = highestVersion([tag?.version, lastReleased].filter((value): value is string => value !== undefined));
  // A release newer than the tag (made in CI, or before a tag failed) starts the commits instead.
  const tagIsLatest = tag !== undefined && (lastReleased === undefined || compareVersions(lastReleased, tag.version) <= 0);
  const live = liveVersion(app.versions);
  let since: string;
  let commits;

  if (tag && tagIsLatest) {
    commits = commitsSince(repo, { tag: tag.tag });
    since = `since ${tag.tag}`;
  } else if (live?.releasedAt) {
    commits = commitsSince(repo, { date: live.releasedAt });
    const why = tag ? `newer than the tag ${tag.tag}` : `no ${prefix}<x.y.z> tag`;
    since = `since ${live.version} was released on ${live.releasedAt.slice(0, 10)} (${why})`;
  } else {
    commits = commitsSince(repo, {});
    since = 'in the whole history (nothing released yet)';
  }

  return { since, analysis: analyze(commits, includeAll), previous };
}

/** Nothing releasable isn't a failure: a push of docs alone shouldn't fail a release job. */
function nothingToRelease(history: History): string {
  const { skipped } = history.analysis;
  return [
    `Nothing to release: no feat, fix, perf, refactor or revert commits ${history.since}${skipped > 0 ? ` (${skipped} others left out)` : ''}.`,
    '  - Write commits as Conventional Commits, like "feat: add CSV export" or "fix(orders): keep the filter".',
    '  - Count every commit with --include-all.',
    '  - Or give both yourself: --version <x.y.z> --message "…"',
  ].join('\n');
}

async function confirm(ctx: Context, options: ReleaseOptions, question: string): Promise<void> {
  if (options.yes) return;

  if (!ctx.prompt) {
    // Both given means nothing was worked out that anyone needs to look at.
    if (options.version !== undefined && options.message !== undefined && !options.edit) return;
    throw new CliError('Nobody is at a terminal to confirm this: pass --yes to release, or --dry-run to only preview.');
  }

  if (!(await confirmed(ctx.prompt, question))) throw new CliError('Cancelled; nothing was released.');
}

function reportReview(ctx: Context, app: AppDetails, result: ReleaseResult): void {
  const status = result.status ?? app.status;
  const waiting = result.awaitingReview.filter((item) => item !== REDIRECT_REVIEW_KEY);

  // A pending or rejected app is live nowhere until FlyCommerce approves it.
  if (result.live === false || status === 'pending' || status === 'rejected') {
    ctx.stdout(`${app.name} is waiting for FlyCommerce's review, so this version goes live once it's approved.`);
  } else if (waiting.length > 0) {
    ctx.stdout(
      `Waiting for FlyCommerce's review; stores keep the approved ones until then:\n${waiting.map((item) => `  - ${item}`).join('\n')}`
    );
  } else if (!result.awaitingReview.includes(REDIRECT_REVIEW_KEY)) {
    ctx.stdout('Everything in it is live.');
  }

  if (result.awaitingReview.includes(REDIRECT_REVIEW_KEY)) {
    ctx.stdout(
      'Your install redirect change waits for review; merchants still return to the approved URL until then — keep that route working.'
    );
  }
}

/** The new version's id; the hub holds one unreleased version at a time, so the same one waiting is picked up again. */
async function createVersion(
  ctx: Context,
  api: PortalApi,
  appPath: string,
  app: AppDetails,
  options: { version: string; changelog: string; title: string; tags: string[] }
): Promise<number> {
  try {
    const created = await api.post<{ versionId: number; version: string }>(`${appPath}/versions`, {
      version: options.version,
      title: options.title,
      changelog: options.changelog,
      ...(options.tags.length > 0 ? { tags: options.tags } : {}),
    });
    ctx.stdout(`Created version ${options.version} (#${created.versionId}) of ${app.name}.`);
    return created.versionId;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'version_waiting') throw error;

    const { versionId, version } = error.details as { versionId?: number; version?: string };

    if (version === options.version && typeof versionId === 'number') {
      ctx.stdout(`Version ${version} (#${versionId}) already exists and isn't released; using it. Its changelog stays as written.`);
      return versionId;
    }

    throw new CliError(
      `Version ${version} (#${versionId}) of ${app.name} is waiting to be released, so ${options.version} can't be created yet.`,
      [
        `Release it: flycommerce app release --version ${version} --message "…"`,
        "Or delete it in the developer portal's Versions tab, then run this again.",
      ]
    );
  }
}
