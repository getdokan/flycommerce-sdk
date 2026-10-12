import crypto from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ExampleDashboard, FakePlatform, startFakePlatform } from '@flycommerce/app-emulator';
import { AppConfig, checkAppConfig, resolveAppConfig } from '@flycommerce/app-server';
import { childEnv } from './child.js';
import { readConfigFile } from './config-file.js';
import { CliError, Context } from './context.js';
import { DEFAULT_COMMAND, DEFAULT_PORT, runApp } from './dev.js';

export const LOCAL_STORE = 'local.flycom.shop';
/** Every permission the emulator's store answers for, so each part of the app can be tried. */
export const LOCAL_SCOPES = ['catalog.read', 'orders.read', 'orders.write', 'webhooks.manage', 'storefront.scripts', 'storefront.customer'];

const READY_TIMEOUT_MS = 60_000;

export interface LocalOptions {
  config?: string;
  port?: string;
  scopes?: string;
  command: string[];
}

function seed(platform: FakePlatform): void {
  const store = platform.store.store(LOCAL_STORE);

  for (const product of [
    { title: 'Linen shirt', price: 39 },
    { title: 'Canvas tote', price: 18 },
    { title: 'Ceramic mug', price: 12 },
  ]) {
    store.addProduct(product);
  }
  for (const order of [
    { firstName: 'Nadia', lastName: 'Rahman', total: 57 },
    { firstName: 'Sam', lastName: 'Okafor', total: 18 },
    { firstName: 'Zoë', lastName: 'Laurent', total: 24 },
  ]) {
    store.addOrder(order);
  }
}

/** Resolves once something accepts connections on the port, or rejects when the app's server stops first. */
async function listening(port: number, stopped: Promise<number>, signal?: AbortSignal): Promise<void> {
  let exited = false;
  void stopped.then(() => (exited = true));
  const until = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < until) {
    if (exited || signal?.aborted) throw new CliError('Your server stopped before it listened.');
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await sleep(200);
  }

  throw new CliError(
    `Nothing listened on port ${port} within ${READY_TIMEOUT_MS / 1000} seconds. Pass the port your server uses with --port.`
  );
}

/** Runs the app against FlyCommerce's emulator on this computer: no portal, no tunnel, nothing leaves the machine. */
export async function devLocal(ctx: Context, options: LocalOptions): Promise<number> {
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`--port must be a port number, like ${DEFAULT_PORT}.`);
  }

  const scopes = options.scopes === undefined ? LOCAL_SCOPES : options.scopes.split(/[\s,]+/).filter(Boolean);
  const file = readConfigFile(ctx, options.config);
  const appUrl = `http://localhost:${port}`;
  const { versionId: _versionId, version: _version, ...config } = file.config;
  const local = { ...config, appUrl };
  const problems = checkAppConfig(local);

  if (problems.length > 0) throw new CliError(`${file.name} is not valid:`, problems);

  const resolved = resolveAppConfig(local as unknown as AppConfig);
  const redirectUri = resolved.install?.redirectUrl ?? `${appUrl}/auth/callback`;
  const appSecret = crypto.randomBytes(24).toString('hex');
  const platform = await startFakePlatform({ appId: file.appId, appSecret, redirectUri });
  let dashboard: ExampleDashboard | undefined;

  try {
    seed(platform);
    dashboard = await ExampleDashboard.start({
      hub: platform.hub,
      appId: file.appId,
      appName: file.appId,
      appUrl,
      store: LOCAL_STORE,
      pages: resolved.dashboard?.pages ?? [],
      scripts: resolved.storefront?.scripts,
      products: platform.store.store(LOCAL_STORE).productList,
    });

    const command = options.command.length > 0 ? options.command : DEFAULT_COMMAND;
    // The emulator's own App ID and secret replace the real ones, which never leave .env.
    const env = childEnv(ctx.env, {
      ...platform.env,
      APP_URL: appUrl,
      REDIRECT_URI: redirectUri,
      PORT: String(port),
      APP_CONFIG_FILE: file.path,
      FRAME_ANCESTORS: dashboard.url,
    });

    ctx.stdout(`Running ${command.join(' ')} against FlyCommerce's emulator, store ${LOCAL_STORE}. Ctrl+C stops everything.\n`);
    const stopped = runApp(ctx, command, env, undefined);

    const install = (async () => {
      await listening(port, stopped, ctx.signal);
      // As the app store does after the merchant approves: FlyCommerce sends them to the app's install URL.
      const { callbackUrl } = platform.hub.install(file.appId, { store: LOCAL_STORE, scopes });
      const answer = await fetch(callbackUrl, { redirect: 'manual' });

      const firstPage = resolved.dashboard?.pages[0];
      const lines = [
        `\nInstalled ${file.appId} on ${LOCAL_STORE} with ${scopes.join(', ')}.`,
        ...(answer.status >= 400
          ? [`Your install callback answered ${answer.status}: its pages may not load until the install works.`]
          : []),
        '',
        ...(firstPage ? [`Dashboard   ${dashboard!.url}/apps/${firstPage.slug}`] : []),
        ...((resolved.storefront?.scripts ?? []).length > 0 ? [`Storefront  ${dashboard!.url}/storefront`] : []),
        `Store API   ${platform.store.url}`,
        '',
        'Everything is in memory: the store, its orders and the install start fresh each run.',
      ];
      ctx.stdout(lines.join('\n'));
    })();

    // A failed install is reported, but the server keeps running so its logs can be read.
    install.catch((error: unknown) => {
      if (!ctx.signal?.aborted) ctx.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    });

    return await stopped;
  } finally {
    await dashboard?.close();
    await platform.close();
  }
}
