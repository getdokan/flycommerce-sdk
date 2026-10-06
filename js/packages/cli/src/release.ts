import { checkAppConfig } from '@flycommerce/app-server';
import { readConfigFile } from './config-file.js';
import { CliError, Context } from './context.js';
import { ApiError, PortalApi } from './portal.js';
import { AppDetails, ReleaseResult } from './types.js';

// awaitingReview names the redirect this way, beside page slugs and script handles.
const REDIRECT_REVIEW_KEY = 'install.redirectUrl';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ReleaseOptions {
  config?: string;
  version?: string;
  message?: string;
  title?: string;
  noRelease?: boolean;
}

export async function release(ctx: Context, portal: string, options: ReleaseOptions): Promise<void> {
  const { version, message } = options;

  if (!version || !VERSION.test(version)) {
    throw new CliError('--version must be three numbers, like 1.2.0.');
  }
  if (!message || message.trim() === '') {
    throw new CliError('--message is required: what changed in this version, for the changelog.');
  }

  const file = readConfigFile(ctx, options.config);
  // The CLI fills these in, so whatever the file says is replaced.
  const { versionId: _versionId, version: _version, ...config } = file.config;
  const problems = checkAppConfig(config);

  if (problems.length > 0) {
    throw new CliError(`${file.name} is not valid:`, problems);
  }

  const api = PortalApi.signedIn(portal, ctx);
  const appPath = `apps/${encodeURIComponent(file.appId)}`;
  const app = await api.get<AppDetails>(appPath);

  if (app.versions.some((candidate) => candidate.version === version && candidate.releasedAt)) {
    throw new CliError(`${version} of ${app.name} is already released. Release a new version number.`);
  }

  const versionId = await createVersion(ctx, api, appPath, app, { version, message, title: options.title });

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
  options: { version: string; message: string; title?: string }
): Promise<number> {
  try {
    const created = await api.post<{ versionId: number; version: string }>(`${appPath}/versions`, {
      version: options.version,
      title: options.title?.trim() || options.version,
      changelog: options.message,
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
