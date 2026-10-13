import net from 'node:net';

/** The config with appUrl replaced, and script srcs and the install redirect on any of `origins` moved onto it. */
export function moveOrigins(config: Record<string, unknown>, appUrl: string, origins: string[]): Record<string, unknown> {
  const move = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
      const url = new URL(value);
      return origins.includes(url.origin) ? `${appUrl}${url.pathname}${url.search}${url.hash}` : value;
    } catch {
      return value;
    }
  };

  const install = config.install as { redirectUrl?: unknown } | undefined;
  const storefront = config.storefront as { scripts?: { src?: unknown }[] } | undefined;

  return {
    ...config,
    appUrl,
    ...(install && typeof install === 'object' && install.redirectUrl !== undefined
      ? { install: { ...install, redirectUrl: move(install.redirectUrl) } }
      : {}),
    ...(storefront && Array.isArray(storefront.scripts)
      ? { storefront: { ...storefront, scripts: storefront.scripts.map((script) => ({ ...script, src: move(script?.src) })) } }
      : {}),
  };
}

/** Every way to write http://localhost:<port>, which a tunnel to that port serves. */
export function loopbackOrigins(port: number): string[] {
  return ['localhost', '127.0.0.1', '[::1]'].map((host) => `http://${host}:${port}`);
}

// FlyCommerce refuses these hosts outside its own local setup.
const LOCAL_SUFFIXES = ['.localhost', '.test', '.internal', '.local'];

function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(host)) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

/** What FlyCommerce would refuse in a release that the config's own check allows, for app dev's sake: URLs only this computer reaches. */
export function releaseProblems(config: Record<string, unknown>): string[] {
  const urls: [string, unknown][] = [['appUrl', config.appUrl]];
  const install = config.install as { redirectUrl?: unknown } | undefined;
  const scripts = (config.storefront as { scripts?: { src?: unknown }[] } | undefined)?.scripts ?? [];

  urls.push(['install.redirectUrl', install?.redirectUrl]);
  scripts.forEach((script, index) => urls.push([`storefront.scripts[${index}].src`, script?.src]));

  const problems: string[] = [];

  for (const [where, value] of urls) {
    if (typeof value !== 'string' || value.startsWith('/')) continue;
    try {
      if (isPrivateHost(new URL(value).hostname)) {
        problems.push(`${where} is ${value}, which only this computer or a private network can reach.`);
      }
    } catch {
      // checkAppConfig reports it.
    }
  }

  return problems;
}
