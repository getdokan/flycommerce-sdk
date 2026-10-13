import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { childEnv } from './child.js';
import { CliError, Context } from './context.js';
import { LOOPBACKS, anyAccepts } from './loopback.js';
import { CLI_VERSION } from './portal.js';
import { printable } from './printable.js';

// The URL alone on its line, as in cloudflared's "Your quick Tunnel has been created!" box; never the API it calls.
const TUNNEL_LINE = /^(?:\S+\s+)?(?:[A-Z]{3}\s+)?\|?\s*(https:\/\/([a-z0-9-]+)\.trycloudflare\.com)\/?\s*\|?\s*$/;
const START_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const CHECK_REQUEST_TIMEOUT_MS = 10_000;
const CHECK_PATH = '/.well-known/flycommerce-tunnel-check/';
// What Cloudflare answers while a new tunnel registers, or its origin is a moment away.
const NOT_YET = [502, 503, 504, 530];
// A wrong page this many times in a row is where the tunnel goes, not a tunnel still starting.
const WRONG_ANSWERS = 3;
const MAX_BODY = 64 * 1024;

export interface Tunnel {
  url: string;
  process: ChildProcess;
  /** Settles when cloudflared exits, whenever that is. */
  exited: Promise<void>;
}

/** The quick tunnel's URL, from a line of cloudflared's output in colour, plain or JSON (TUNNEL_LOGFORMAT=json). */
export function tunnelUrlFromLine(line: string): string | undefined {
  let text = printable(line).trim();

  if (text.startsWith('{')) {
    try {
      const { message } = JSON.parse(text) as { message?: unknown };
      text = typeof message === 'string' ? printable(message).trim() : '';
    } catch {
      return undefined;
    }
  }

  const match = TUNNEL_LINE.exec(text);
  return match && match[2] !== 'api' ? match[1] : undefined;
}

/** A Cloudflare quick tunnel to the local port. The CLI never downloads cloudflared; FLYCOMMERCE_CLOUDFLARED points at another binary. */
export function startCloudflared(ctx: Context, port: number): Promise<Tunnel> {
  const binary = ctx.env.FLYCOMMERCE_CLOUDFLARED || 'cloudflared';
  // Without --config, cloudflared reads ~/.cloudflared/config.yml, whose ingress rules win over --url.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-cloudflared-'));
  const config = path.join(configDir, 'config.yml');
  fs.writeFileSync(config, '{}\n');
  const removeConfig = () => fs.rmSync(configDir, { recursive: true, force: true });

  let child: ChildProcess;
  try {
    child = spawn(binary, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://localhost:${port}`], {
      cwd: ctx.cwd,
      env: childEnv(ctx.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    removeConfig();
    throw error;
  }
  child.once('exit', removeConfig);
  child.once('error', removeConfig);
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
        recent.push(printable(line).trim());
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

interface TokenServer {
  close(): Promise<void>;
}

/** Answers the token on the port, on both loopbacks; undefined when something else already holds the port. */
async function serveToken(port: number, token: string): Promise<TokenServer | undefined> {
  if (await anyAccepts(port)) return undefined;

  const servers: http.Server[] = [];
  const close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
  };

  for (const host of LOOPBACKS) {
    const server = http.createServer((req, res) => {
      // A tunnel URL with a path forwards it too.
      const ok = req.method === 'GET' && (req.url ?? '').endsWith(`${CHECK_PATH}${token}`);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(ok ? token : 'Not found');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      servers.push(server);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A computer without IPv6 has no ::1.
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') continue;
      await close();
      if (code === 'EADDRINUSE') return undefined;
      throw error;
    }
  }

  return servers.length > 0 ? { close } : undefined;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

// Asked too early, the system resolver caches a new tunnel's "no such host" for minutes, browsers included; c-ares doesn't.
const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });

function lookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  if (net.isIP(hostname) || hostname === 'localhost') {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) =>
      options.all || error ? callback(error, addresses) : callback(null, addresses[0].address, addresses[0].family)
    );
    return;
  }

  void Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then(([v4, v6]) => {
    const addresses: dns.LookupAddress[] = [
      ...(v4.status === 'fulfilled' && options.family !== 6 ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' && options.family !== 4 ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];

    if (addresses.length > 0) {
      return options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
    }

    const code = v4.status === 'rejected' ? (v4.reason as NodeJS.ErrnoException).code : undefined;
    // c-ares can't reach a DNS server here (a VPN's own resolver, say), so the system's is all there is.
    if (code !== dns.NOTFOUND && code !== dns.NODATA) {
      dns.lookup(hostname, { ...options, all: true }, (error, found) =>
        options.all || error ? callback(error, found) : callback(null, found[0].address, found[0].family)
      );
      return;
    }

    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }), []);
  });
}

/** fetch's shape over node:https, for the lookup above; the body is cut at MAX_BODY. */
function requestThroughTunnel(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const client = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      { headers: init?.headers as Record<string, string>, signal: init?.signal ?? undefined, lookup: lookup as never },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size < MAX_BODY) chunks.push(chunk);
          size += chunk.length;
        });
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599) return reject(new Error(`HTTP ${status}`));
          const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).subarray(0, MAX_BODY);
          resolve(new Response(body, { status }));
        });
        response.once('error', reject);
      }
    );
    request.once('error', reject);
  });
}

export interface TunnelProbe {
  url: string;
  port: number;
  /** A quick tunnel this CLI started, rather than --tunnel-url. */
  quick: boolean;
  exited?: Promise<void>;
}

/** Resolves once a request to the tunnel URL comes out on the port; the app's server isn't running yet, so the CLI answers it. */
export async function probeTunnel(ctx: Context, { url, port, quick, exited }: TunnelProbe): Promise<void> {
  const token = crypto.randomBytes(16).toString('hex');
  const server = await serveToken(port, token);

  if (!server) {
    ctx.stderr(
      `Warning: something is already listening on port ${port}, so the tunnel wasn't checked. If your store can't load the app, check that ${url} reaches http://localhost:${port}.`
    );
    return;
  }

  const timeout = ctx.tunnelCheckTimeoutMs ?? CHECK_TIMEOUT_MS;
  const until = Date.now() + timeout;
  const request = ctx.tunnelFetch ?? requestThroughTunnel;
  let stopped = false;
  void exited?.then(() => (stopped = true));
  let answer: string | undefined;
  let wrong = 0;

  try {
    for (;;) {
      try {
        const response = await request(`${url}${CHECK_PATH}${token}`, {
          headers: { 'User-Agent': `flycommerce-cli/${CLI_VERSION}` },
          redirect: 'manual',
          signal: AbortSignal.any([AbortSignal.timeout(CHECK_REQUEST_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]),
        });
        const body = await response.text();
        if (response.status === 200 && body === token) return;
        answer = response.status === 200 ? 'answered 200 with another page' : `answered ${response.status}`;
        wrong = NOT_YET.includes(response.status) ? 0 : wrong + 1;
      } catch {
        // No DNS for a new quick tunnel yet, or no answer in time: wait for the deadline.
        wrong = 0;
      }

      if (ctx.signal?.aborted) throw new CliError('Cancelled.');
      if (stopped) throw new CliError('The tunnel stopped, so the app is no longer reachable. Run flycommerce app dev again.');
      if (wrong >= WRONG_ANSWERS || Date.now() >= until) break;
      await sleep(Math.min(1000, timeout / 10));
    }
  } finally {
    await server.close();
  }

  const local = `http://localhost:${port}`;
  const hints = quick
    ? [
        answer
          ? `cloudflared may be following the ingress rules in a config file, like ~/.cloudflared/config.yml, instead of --url. app dev runs it with an empty --config of its own; if FLYCOMMERCE_CLOUDFLARED is a wrapper, make it pass on every argument.`
          : `Check that this computer can reach ${new URL(url).host}: a VPN, proxy or firewall can block it. Then run flycommerce app dev again.`,
        `Or pass your own tunnel to ${local} with --tunnel-url.`,
      ]
    : [
        `Check that the tunnel sends requests to ${local}: for a named Cloudflare tunnel, its ingress rules in ~/.cloudflared/config.yml or the Cloudflare dashboard decide where they go.`,
        'If it serves another port, pass that port with --port.',
      ];
  const what = answer ? `doesn't reach port ${port} on this computer: it ${answer}` : `didn't answer within ${timeout / 1000} seconds`;

  throw new CliError(`The tunnel ${url} ${what}. Nothing was pushed to the development app.`, hints);
}
