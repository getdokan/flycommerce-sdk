import { ChildProcess } from 'node:child_process';
import { AppConfig, checkAppConfig, resolveAppConfig } from '@flycommerce/app-server';
import { childEnv, spawnCommand } from './child.js';
import { readConfigFile } from './config-file.js';
import { CliError, Context } from './context.js';
import { ApiError, PortalApi, printable } from './portal.js';
import { Tunnel, startCloudflared } from './tunnel.js';
import { DevConfigResult } from './types.js';
import { withoutTrailingSlashes } from './url.js';

export const DEFAULT_PORT = 4000;
export const DEFAULT_COMMAND = ['npm', 'start'];

export interface DevOptions {
  config?: string;
  port?: string;
  tunnelUrl?: string;
  command: string[];
}

/** Serves a development app from this computer: tunnel, push the config with appUrl = tunnel, run the app's server. Resolves to its exit code. */
export async function dev(ctx: Context, portal: string, options: DevOptions): Promise<number> {
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`--port must be a port number, like ${DEFAULT_PORT}.`);
  }

  const file = readConfigFile(ctx, options.config);
  // Versions are for releases; a dev push has none.
  const { versionId: _versionId, version: _version, ...config } = file.config;
  // appUrl stays required: the server loads this same file, and the tunnel only replaces it in the push.
  const shapeProblems = checkAppConfig(config);

  if (shapeProblems.length > 0) {
    throw new CliError(`${file.name} is not valid:`, shapeProblems);
  }

  const api = PortalApi.signedIn(portal, ctx);
  let tunnel: Tunnel | undefined;
  let appUrl: string;

  if (options.tunnelUrl !== undefined) {
    appUrl = withoutTrailingSlashes(options.tunnelUrl);
  } else {
    ctx.stdout(`Starting a Cloudflare quick tunnel to http://localhost:${port}…`);
    tunnel = await startCloudflared(ctx, port);
    appUrl = tunnel.url;
  }

  const stopTunnel = () => tunnel?.process.kill();
  let tunnelDown = false;
  void tunnel?.exited.then(() => (tunnelDown = true));
  const checkTunnel = () => {
    if (tunnelDown) throw new CliError('The tunnel stopped, so the app is no longer reachable. Run flycommerce app dev again.');
  };

  try {
    const pushed = { ...config, appUrl };
    const problems = checkAppConfig(pushed);

    if (problems.length > 0) {
      const absoluteSrc = problems.some((problem) => /^storefront\.scripts\[\d+\]\.src must be on /.test(problem));
      throw new CliError(
        `${file.name} doesn't work with appUrl ${appUrl}:`,
        absoluteSrc ? [...problems, 'Write each script src as a path, like /storefront/widget.js, so it follows appUrl.'] : problems
      );
    }

    let result: DevConfigResult;

    try {
      result = await api.put<DevConfigResult>(`apps/${encodeURIComponent(file.appId)}/dev-config`, { config: pushed });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        throw new CliError(error.message, ['Use a development app: flycommerce app link --config dev']);
      }
      throw error;
    }

    checkTunnel();

    // The hub's copy is what the install exchange compares, byte for byte.
    const resolved = resolveAppConfig(pushed as unknown as AppConfig);
    const redirectUri =
      typeof result.redirectUrl === 'string' && result.redirectUrl !== ''
        ? result.redirectUrl
        : (resolved.install?.redirectUrl ?? `${appUrl}/auth/callback`);
    const command = options.command.length > 0 ? options.command : DEFAULT_COMMAND;

    printSummary(ctx, file.name, result, appUrl, command, port);

    if (result.reinstallRequired) {
      ctx.stdout(
        `\n${result.message ? printable(result.message) : 'Reinstall the app on your store to grant the permissions this config adds, like storefront.scripts.'}`
      );
    }

    if (resolved.install?.redirectUrl === undefined) {
      ctx.stdout(
        `\nNote: ${file.name} has no install.redirectUrl, so the app keeps the redirect URL set in the portal and installs won't come back through the tunnel. Add "install": { "redirectUrl": "/auth/callback" }.`
      );
    }

    return await runApp(
      ctx,
      command,
      childEnv(ctx.env, { APP_URL: appUrl, REDIRECT_URI: redirectUri, PORT: String(port), APP_CONFIG_FILE: file.path }),
      tunnel
    );
  } finally {
    stopTunnel();
  }
}

function printSummary(ctx: Context, fileName: string, result: DevConfigResult, appUrl: string, command: string[], port: number): void {
  const lines = [
    `\nPushed ${fileName} to the development app, served from ${result.appUrl || appUrl}.`,
    '',
    `Install it on your store:  ${result.installUrl}`,
  ];
  const pages = (result.pages ?? []).flatMap((page) => [page, ...(page.children ?? [])]);

  if (pages.length > 0) {
    lines.push('', "Dashboard pages (open them from Apps in your store's dashboard):");
    lines.push(...pages.map((page) => `  ${page.label}  ${page.url}`));
  }
  if ((result.scripts ?? []).length > 0) {
    lines.push('', "Storefront scripts (they run on your store's catalogue pages once installed):");
    lines.push(...result.scripts.map((script) => `  ${script.handle}  ${script.src}`));
  }

  lines.push('', `Running ${command.join(' ')} with APP_URL, REDIRECT_URI and PORT=${port}. Ctrl+C stops it and the tunnel.`, '');
  ctx.stdout(lines.join('\n'));
}

function runApp(ctx: Context, command: string[], env: NodeJS.ProcessEnv, tunnel: Tunnel | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let stopping = false;
    let tunnelDied = false;

    try {
      child = spawnCommand(command, { cwd: ctx.cwd, env, stdio: 'inherit' });
    } catch (error) {
      reject(new CliError(`Couldn't run ${command[0]}: ${(error as Error).message}`));
      return;
    }

    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill('SIGTERM');
      // A server that ignores SIGTERM still goes.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };

    const onAbort = () => stop();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) stop();

    void tunnel?.exited.then(() => {
      if (stopping) return;
      tunnelDied = true;
      ctx.stderr('Error: The tunnel stopped, so the app is no longer reachable. Stopping your server; run flycommerce app dev again.');
      stop();
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      reject(
        new CliError(
          error.code === 'ENOENT'
            ? `Couldn't run ${command[0]}: it isn't installed or isn't on PATH. Put your server's command after --.`
            : `Couldn't run ${command[0]}: ${error.message}`
        )
      );
    });

    child.once('exit', (code, signal) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (tunnelDied) return resolve(1);
      if (ctx.signal?.aborted) return resolve(0);
      if (stopping) return resolve(1);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
