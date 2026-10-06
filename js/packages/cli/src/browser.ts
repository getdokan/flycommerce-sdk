import { spawn } from 'node:child_process';

/** Opens the URL in the default browser; does nothing when there is none, since the URL is printed too. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // rundll32 takes the URL as one argument; `start` would split it at each &.
          ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser here.
  }
}
