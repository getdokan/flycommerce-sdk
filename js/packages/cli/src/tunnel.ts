import { ChildProcess, spawn } from 'node:child_process';
import { childEnv } from './child.js';
import { CliError, Context } from './context.js';

// The URL alone on its line, as in cloudflared's "Your quick Tunnel has been created!" box; never the API it calls.
const TUNNEL_LINE = /^(?:\S+\s+)?(?:[A-Z]{3}\s+)?\|?\s*(https:\/\/([a-z0-9-]+)\.trycloudflare\.com)\/?\s*\|?\s*$/;
const START_TIMEOUT_MS = 60_000;

export interface Tunnel {
  url: string;
  process: ChildProcess;
  /** Settles when cloudflared exits, whenever that is. */
  exited: Promise<void>;
}

export function tunnelUrlFromLine(line: string): string | undefined {
  const match = TUNNEL_LINE.exec(line.trim());
  return match && match[2] !== 'api' ? match[1] : undefined;
}

/** A Cloudflare quick tunnel to the local port. The CLI never downloads cloudflared; FLYCOMMERCE_CLOUDFLARED points at another binary. */
export function startCloudflared(ctx: Context, port: number): Promise<Tunnel> {
  const binary = ctx.env.FLYCOMMERCE_CLOUDFLARED || 'cloudflared';
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    cwd: ctx.cwd,
    env: childEnv(ctx.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const recent: string[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    const partial = { stdout: '', stderr: '' };

    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    // Read for as long as it runs: a full pipe would stall cloudflared.
    const reader = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const lines = (partial[stream] + chunk.toString()).split(/\r?\n/);
      partial[stream] = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() === '') continue;
        recent.push(line.replace(/[\x00-\x1f\x7f]/g, '').trim());
        recent.splice(0, Math.max(0, recent.length - 5));
        const url = tunnelUrlFromLine(line);

        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ url, process: child, exited });
        }
      }
    };

    child.stdout!.on('data', reader('stdout'));
    child.stderr!.on('data', reader('stderr'));

    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        new CliError(
          error.code === 'ENOENT'
            ? "cloudflared isn't installed, so there's no tunnel. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or pass the https URL of your own tunnel with --tunnel-url."
            : `cloudflared didn't start: ${error.message}`
        )
      );
    });
    void exited.then(() => fail(new CliError('cloudflared stopped before it gave a tunnel URL:', recent)));

    const timer = setTimeout(() => fail(new CliError('cloudflared gave no tunnel URL within a minute:', recent)), START_TIMEOUT_MS);
    ctx.signal?.addEventListener('abort', () => fail(new CliError('Cancelled.')), { once: true });
  });
}
