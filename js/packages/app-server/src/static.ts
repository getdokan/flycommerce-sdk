import fs from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import path from 'node:path';
import { AppConfig, pagePaths } from './app-config.js';
import { escapeHtml } from './http.js';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export interface WebAppOptions {
  /** The Vite build output: index.html plus assets/. */
  root: string;
  /** Written into each page as <meta name="flycom-app-id">, which appIdFromPage() reads. */
  appId: string;
  /** The app's app-config.json, whose page paths are served. */
  config?: AppConfig;
  /** Paths that render the app, e.g. /overview. Taken from `config` when it is given. */
  pages?: string[];
  frameAncestors?: string[];
}

/**
 * Serves a built single-page app: hashed assets from /assets/, and index.html on each page path.
 * Returns false when the request is for neither, so the caller can route it.
 */
export async function serveWebApp(
  method: string | undefined,
  pathname: string,
  res: ServerResponse,
  options: WebAppOptions
): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  const pages = options.pages ?? (options.config ? pagePaths(options.config) : []);

  if (pages.includes(pathname)) {
    const index = await fs.readFile(path.join(options.root, 'index.html'), 'utf8');
    const body = index.replace('</head>', `  <meta name="flycom-app-id" content="${escapeHtml(options.appId)}">\n  </head>`);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(options.frameAncestors ? { 'Content-Security-Policy': `frame-ancestors ${options.frameAncestors.join(' ')}` } : {}),
    });
    res.end(method === 'HEAD' ? undefined : body);

    return true;
  }

  if (!pathname.startsWith('/assets/')) {
    return false;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const assets = path.join(options.root, 'assets');
  const file = path.resolve(options.root, `.${decoded}`);
  const type = CONTENT_TYPES[path.extname(file)];

  if (!file.startsWith(assets + path.sep) || !type) {
    return false;
  }

  try {
    const body = await fs.readFile(file);

    res.writeHead(200, {
      'Content-Type': type,
      // Vite puts a content hash in every asset name, so a changed file is a new URL.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : body);

    return true;
  } catch {
    return false;
  }
}
