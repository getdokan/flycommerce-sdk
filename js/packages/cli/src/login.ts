import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CliError, Context } from './context.js';
import { saveCredential } from './credentials.js';
import { PortalApi } from './portal.js';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** Browser sign-in: a one-time code sent to a loopback server, exchanged with the PKCE verifier only this process knows. */
export async function login(ctx: Context, portal: string): Promise<void> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  let ignored = 0;
  const loopback = await startLoopback(state, ctx.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, ctx.signal, () => {
    // Said once: anything on this computer can call the loopback, as often as it likes.
    if (ignored++ === 0) ctx.stderr("Ignored an answer that doesn't match this sign-in (state mismatch). Still waiting…");
  });
  const redirectUri = `${loopback.url}/callback`;

  const authorize = new URL(`${portal}/cli/authorize`);
  authorize.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  ctx.stdout(`Opening your browser to sign in to ${portal}. If it doesn't open, go to:\n\n  ${authorize}\n`);
  ctx.stdout('Waiting for you to allow the FlyCommerce CLI (Ctrl+C to cancel)…');
  try {
    ctx.openUrl(authorize.toString());
  } catch {
    // The printed link still works.
  }

  const code = await loopback.code;
  const anonymous = PortalApi.anonymous(portal, ctx);
  const { token, expiresAt } = await anonymous.post<{ token?: unknown; expiresAt?: unknown }>('token', {
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  if (typeof token !== 'string' || token === '') {
    throw new CliError(`${portal} did not return a token.`);
  }

  const { backup } = saveCredential(ctx.env, portal, { token, ...(typeof expiresAt === 'string' ? { expiresAt } : {}) });

  if (backup) {
    ctx.stderr(`The credentials file couldn't be read, so it was kept as ${backup} and a new one started.`);
  }

  try {
    const me = await PortalApi.withToken(portal, token, ctx).get<{ name?: string; email?: string }>('me');
    ctx.stdout(`Signed in to ${portal} as ${describeUser(me)}.`);
  } catch {
    ctx.stdout(`Signed in to ${portal}.`);
  }
}

export function describeUser(me: { name?: string; email?: string }): string {
  return [me.name, me.email ? `<${me.email}>` : undefined].filter(Boolean).join(' ') || 'an unnamed account';
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body></html>`;

function startLoopback(
  state: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onIgnored: () => void
): Promise<{ url: string; code: Promise<string> }> {
  let settle: { resolve(code: string): void; reject(error: Error): void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  let done = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, title: string, text: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(page(title, text));
    };

    if (req.method !== 'GET' || url.pathname !== '/callback' || done) {
      return reply(404, 'Not found', 'Nothing here.');
    }

    const error = url.searchParams.get('error');
    const returned = url.searchParams.get('state') ?? '';
    const received = url.searchParams.get('code');

    // Anything on this computer can call the loopback; only an answer carrying our state can end the sign-in.
    if (!sameState(returned, state)) {
      reply(400, 'Sign-in refused', "This answer doesn't belong to the sign-in this terminal started.");
      onIgnored();
      return;
    }
    if (error === 'access_denied') {
      reply(200, 'Sign-in cancelled', 'Nothing was saved. You can close this tab.');
      return finish(new CliError('Sign-in was cancelled in the browser. Nothing was saved.'));
    }
    if (error) {
      reply(200, 'Sign-in failed', 'The portal refused this sign-in request. Nothing was saved.');
      return finish(
        new CliError(
          `The portal refused the sign-in request (${error.replace(/[^a-z_]/g, '').slice(0, 40) || 'no reason given'}). Nothing was saved. Run flycommerce login again.`
        )
      );
    }
    if (!received) {
      reply(400, 'Sign-in failed', 'No code came back. Run flycommerce login again.');
      return finish(new CliError('The portal sent no code. Run flycommerce login again.'));
    }

    reply(200, 'Signed in', 'You can close this tab and go back to the terminal.');
    finish(received);
  });

  const timer = setTimeout(() => finish(new CliError('Sign-in timed out. Run flycommerce login again.')), timeoutMs);
  const onAbort = () => finish(new CliError('Sign-in cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });

  function finish(result: string | Error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeIdleConnections();
    if (typeof result === 'string') settle.resolve(result);
    else settle.reject(result);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, code });
    });
  });
}

function sameState(returned: string, expected: string): boolean {
  const a = Buffer.from(returned);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
