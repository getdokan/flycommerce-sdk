import { ChildProcess, spawn } from 'node:child_process';
import { CliError, Context } from './context.js';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 60_000;

export interface Tunnel {
  url: string;
  process: ChildProcess;
}

/** A Cloudflare quick tunnel to the local port. The CLI never downloads cloudflared; FLYCOMMERCE_CLOUDFLARED points at another binary. */
export function startCloudflared(ctx: Context, port: number): Promise<Tunnel> {
  const binary = ctx.env.FLYCOMMERCE_CLOUDFLARED || 'cloudflared';
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    cwd: ctx.cwd,
    env: ctx.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recent: string[] = [];

  return new Promise((resolve, reject) => {
    let found = false;

    const fail = (error: CliError) => {
      if (found) return;
      found = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    // Read for as long as it runs: a full pipe would stall cloudflared.
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      recent.push(...text.split('\n').filter((line) => line.trim() !== ''));
      recent.splice(0, Math.max(0, recent.length - 5));
      const match = TUNNEL_URL.exec(text);

      if (match && !found) {
        found = true;
        clearTimeout(timer);
        resolve({ url: match[0], process: child });
      }
    };

    child.stdout!.on('data', read);
    child.stderr!.on('data', read);

    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        new CliError(
          error.code === 'ENOENT'
            ? "cloudflared isn't installed, so there's no tunnel. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or pass the https URL of your own tunnel with --tunnel-url."
            : `cloudflared didn't start: ${error.message}`
        )
      );
    });
    child.once('exit', () => {
      fail(new CliError('cloudflared stopped before it gave a tunnel URL.', recent));
    });

    const timer = setTimeout(() => fail(new CliError('cloudflared gave no tunnel URL within a minute.', recent)), START_TIMEOUT_MS);
    ctx.signal?.addEventListener('abort', () => fail(new CliError('Cancelled.')), { once: true });
  });
}
