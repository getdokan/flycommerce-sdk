import { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  // API answers carry a store's data; never let a browser or proxy keep them.
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function html(res: ServerResponse, body: string, frameAncestors?: string[], status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...(frameAncestors ? { 'Content-Security-Policy': `frame-ancestors ${frameAncestors.join(' ')}` } : {}),
  });
  res.end(body);
}

export async function readRawBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);

  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function sendError(res: ServerResponse, error: unknown, label: string): void {
  if (error instanceof HttpError) {
    return json(res, error.status, { error: error.code, message: error.message });
  }

  console.error(`[${label}]`, error);
  json(res, 500, { error: 'internal_error' });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
